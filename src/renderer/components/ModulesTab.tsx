import { useEffect, useState } from 'react';
import type { Job, MatrixEstimate, Module, ModuleSummary, ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { JOB_STATUS, time } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { EstimatePanel } from './MatrixTab';
import { tr } from '../i18n';
import { Button, IconButton, Input, Table, Textarea } from '../ui';

interface FormProps {
  project: ProjectInfo;
  run: RunFn;
  module?: Module;
  onDone: (m: Module | undefined) => void;
}

/** Create/edit form of a module; globs are one per line. */
export function ModuleForm({ project, run, module, onDone }: FormProps) {
  const [name, setName] = useState(module?.name ?? '');
  const [globs, setGlobs] = useState(module?.globs.join('\n') ?? '');
  const [description, setDescription] = useState(module?.description ?? '');
  const [preview, setPreview] = useState<{ count: number; sample: string[] } | null>(null);
  const list = () => globs.split('\n').map((g) => g.trim()).filter(Boolean);

  const save = async () => {
    const m = await run(api.saveModule(project.id, { id: module?.id, name, globs: list(), description }));
    if (m) onDone(m);
  };

  return (
    <div className="form module-form">
      <label>
        {tr('Name')}
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="wide">
        {tr('Globs (one per line, “!” excludes)')}
        <Textarea rows={3} value={globs} onChange={(e) => (setGlobs(e.target.value), setPreview(null))} placeholder="service-a/**" />
      </label>
      <label className="wide">
        {tr('Description')}
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="wide row">
        <Button variant="primary" disabled={!name.trim() || !list().length} onClick={() => void save()}>
          {tr('Save')}
        </Button>
        <IconButton
          icon="search"
          title={tr('Show the files the module will contain')}
          label={tr('Check globs')}
          disabled={!list().length}
          onClick={() => void run(api.previewGlobs(project.id, list())).then((p) => p && setPreview(p))}
        />
        <Button onClick={() => onDone(undefined)}>{tr('Cancel')}</Button>
        {preview && <span className="muted">{tr('files: {n}', { n: preview.count })}</span>}
      </div>
      {preview && preview.sample.length > 0 && (
        <pre className="wide muted small">
          {preview.sample.join('\n')}
          {preview.count > preview.sample.length ? '\n…' : ''}
        </pre>
      )}
    </div>
  );
}

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onOpenMap: (moduleId: string) => void;
  onTerminal: (id: string | undefined) => void;
}

export function ModulesTab({ project, revision, run, selection, onSelect, onOpenMap, onTerminal }: Props) {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [markupJob, setMarkupJob] = useState<Job | null>(null);
  const [hint, setHint] = useState('');
  const [creating, setCreating] = useState(false);
  const [hunt, setHunt] = useState<{ ids: string[]; estimate: MatrixEstimate } | null>(null);

  useEffect(() => {
    void run(api.listModules(project.id)).then((ms) => ms && setModules(ms));
    void api
      .listJobs(project.id)
      .then((js) => setMarkupJob(js.find((j) => j.entityType === 'module_map' && (j.status === 'queued' || j.status === 'running')) ?? null));
  }, [project.id, revision, run]);

  const g = useGrid('modules', modules, [
    { key: 'name', title: tr('Module'), text: (m) => m.name },
    { key: 'globs', title: 'Globs', text: (m) => m.globs.join(' ') },
    { key: 'description', title: tr('Description'), text: (m) => m.description },
    {
      key: 'map',
      title: tr('Entry point map'),
      text: (m) => (m.latestSnapshot ? (m.snapshotStale ? tr('stale|map') : tr('yes')) : tr('no')),
      sort: (m) => m.latestSnapshot?.entryCount ?? -1,
      filter: 'enum',
    },
    { key: 'actions', title: '', className: 'actions' },
  ], { revealKey: (m) => `module:${m.id}` });

  const estimateHunt = async (ids: string[]) => {
    const estimate = await run(api.estimateHunt(project.id, ids));
    if (estimate) setHunt({ ids, estimate });
  };
  const startHunt = async () => {
    if (hunt && (await run(api.runHunt(project.id, hunt.ids)))) setHunt(null);
  };
  const buildMaps = async () => {
    for (const m of hunt?.estimate.modulesWithoutMap ?? []) await run(api.enqueueEntryPoints(project.id, m.id));
    if (hunt) await estimateHunt(hunt.ids);
  };

  const markup = async () => {
    const job = await run(api.enqueueModuleMarkup(project.id, hint));
    if (job) setHint('');
  };

  return (
    <div className="modules-tab">
      <div className="toolbar">
        <IconButton icon="plus" title={tr('Add a module manually')} label={tr('Module')} aria-pressed={creating} onClick={() => setCreating((c) => !c)} />
        <IconButton
          icon="route"
          title={tr('Build entry point maps of all modules')}
          label={tr('Map all')}
          disabled={!modules.length}
          onClick={() => void run(api.enqueueAllEntryPoints(project.id))}
        />
        <IconButton
          icon="finding"
          title={tr('Hunt for vulnerabilities of any kind in the modules shown, not only those the requirements name')}
          label={tr('Hunt')}
          disabled={!g.all.length}
          onClick={() => void estimateHunt(g.all.map((m) => m.id))}
        />
        {markupJob && (
          <span className="muted">
            {tr('Markup: {status}', { status: JOB_STATUS[markupJob.status] })}
            {markupJob.lastRunId && (
              <>
                {' '}
                <IconButton icon="output" title={tr('Watch output')} onClick={() => void run(api.openRun(project.id, markupJob.lastRunId!)).then(onTerminal)} />
              </>
            )}
          </span>
        )}
      </div>

      {hunt && (
        <EstimatePanel estimate={hunt.estimate} title={tr('vulnerability hunt')} batchSetting="hunt.batch_files" perFile onBuildMaps={() => void buildMaps()} onRun={() => void startHunt()} onCancel={() => setHunt(null)} />
      )}

      {creating && (
        <div className="card">
          <strong>{tr('New module')}</strong>
          <ModuleForm
            project={project}
            run={run}
            onDone={(m) => {
              setCreating(false);
              if (m) onSelect({ kind: 'module', id: m.id });
            }}
          />
        </div>
      )}

      <details className="card" open={modules.length === 0}>
        <summary>{tr('AI module markup')}</summary>
        <div className="form">
          <label className="wide">
            {tr('Hints (optional): which parts of the repository to mark up, how to name them')}
            <Textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} />
          </label>
          <IconButton icon="wand" variant="primary" title={tr('Mark up modules with AI')} label={tr('Mark up')} disabled={Boolean(markupJob)} onClick={() => void markup()} />
        </div>
      </details>

      {g.count && <div className="toolbar">{g.count}</div>}
      <Table>
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {tr('No modules. Run the markup or add a module.')}
            </EmptyRow>
          )}
          {g.rows.map((m) => (
            <tr
              key={m.id}
              className={selection?.kind === 'module' && selection.id === m.id ? 'selected' : ''}
              onClick={() => onSelect({ kind: 'module', id: m.id })}
            >
              <td>
                <strong>{m.name}</strong>
              </td>
              <td className="mono small">{m.globs.join(' ')}</td>
              <td>{m.description}</td>
              <td>
                {m.latestSnapshot ? (
                  <span title={tr('run {id}', { id: m.latestSnapshot.runId })}>
                    {m.latestSnapshot.entryCount} · <span className="mono">{m.latestSnapshot.commitSha.slice(0, 8)}</span> ·{' '}
                    {time(m.latestSnapshot.createdAt)}
                    {m.snapshotStale && (
                      <span className="status stale" title={tr('module or call chain code changed after the snapshot')}>
                        {' '}
                        {tr('stale|map')}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="muted">{tr('no')}</span>
                )}
                {m.activeJob && <span className={`status s-${m.activeJob.status}`}> {JOB_STATUS[m.activeJob.status]}</span>}
              </td>
              <td className="actions" onClick={(e) => e.stopPropagation()}>
                <IconButton icon="map" title={tr('Open map')} disabled={!m.latestSnapshot} onClick={() => onOpenMap(m.id)} />
                <IconButton
                  icon={m.latestSnapshot ? 'recheck' : 'route'}
                  title={m.latestSnapshot ? tr('Rebuild map') : tr('Build map')}
                  disabled={Boolean(m.activeJob)}
                  onClick={() => void run(api.enqueueEntryPoints(project.id, m.id))}
                />
                <IconButton icon="finding" title={tr('Hunt for vulnerabilities in the module')} onClick={() => void estimateHunt([m.id])} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {g.pager}
    </div>
  );
}
