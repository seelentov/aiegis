import { useEffect, useState } from 'react';
import type { Job, Module, ModuleSummary, ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { JOB_STATUS, time } from '../format';
import type { Selection } from './DetailsPanel';

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
        Имя
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="wide">
        Globs (по одному в строке, «!» исключает)
        <textarea rows={3} value={globs} onChange={(e) => (setGlobs(e.target.value), setPreview(null))} placeholder="service-a/**" />
      </label>
      <label className="wide">
        Описание
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="wide row">
        <button className="primary" disabled={!name.trim() || !list().length} onClick={() => void save()}>
          Сохранить
        </button>
        <button disabled={!list().length} onClick={() => void run(api.previewGlobs(project.id, list())).then((p) => p && setPreview(p))}>
          Проверить globs
        </button>
        <button onClick={() => onDone(undefined)}>Отмена</button>
        {preview && <span className="muted">файлов: {preview.count}</span>}
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

  useEffect(() => {
    void run(api.listModules(project.id)).then((ms) => ms && setModules(ms));
    void api
      .listJobs(project.id)
      .then((js) => setMarkupJob(js.find((j) => j.entityType === 'module_map' && (j.status === 'queued' || j.status === 'running')) ?? null));
  }, [project.id, revision, run]);

  const markup = async () => {
    const job = await run(api.enqueueModuleMarkup(project.id, hint));
    if (job) setHint('');
  };

  return (
    <div className="modules-tab">
      <div className="toolbar">
        <button onClick={() => setCreating((c) => !c)}>+ Модуль вручную</button>
        <button disabled={!modules.length} onClick={() => void run(api.enqueueAllEntryPoints(project.id))}>
          Построить карты всех модулей
        </button>
        {markupJob && (
          <span className="muted">
            Разметка: {JOB_STATUS[markupJob.status]}
            {markupJob.lastRunId && (
              <>
                {' '}
                <button onClick={() => void run(api.openRun(project.id, markupJob.lastRunId!)).then(onTerminal)}>Поток</button>
              </>
            )}
          </span>
        )}
      </div>

      {creating && (
        <div className="card">
          <strong>Новый модуль</strong>
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
        <summary>Разметка модулей ИИ</summary>
        <div className="form">
          <label className="wide">
            Указания (необязательно): какие части репозитория размечать, как именовать
            <textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} />
          </label>
          <button className="primary" disabled={Boolean(markupJob)} onClick={() => void markup()}>
            Разметить
          </button>
        </div>
      </details>

      <table className="grid">
        <thead>
          <tr>
            <th>Модуль</th>
            <th>Globs</th>
            <th>Описание</th>
            <th>Карта точек входа</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {modules.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Модулей нет — запустите разметку или добавьте вручную
              </td>
            </tr>
          )}
          {modules.map((m) => (
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
                  <span title={`прогон ${m.latestSnapshot.runId}`}>
                    {m.latestSnapshot.entryCount} · <span className="mono">{m.latestSnapshot.commitSha.slice(0, 8)}</span> ·{' '}
                    {time(m.latestSnapshot.createdAt)}
                    {m.snapshotStale && (
                      <span className="status stale" title="код модуля или цепочек вызовов изменился после снимка">
                        {' '}
                        устарела
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="muted">нет</span>
                )}
                {m.activeJob && <span className={`status s-${m.activeJob.status}`}> {JOB_STATUS[m.activeJob.status]}</span>}
              </td>
              <td className="actions" onClick={(e) => e.stopPropagation()}>
                <button disabled={!m.latestSnapshot} onClick={() => onOpenMap(m.id)}>
                  Карта
                </button>
                <button disabled={Boolean(m.activeJob)} onClick={() => void run(api.enqueueEntryPoints(project.id, m.id))}>
                  Построить
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
