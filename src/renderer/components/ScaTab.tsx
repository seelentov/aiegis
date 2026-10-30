import { useEffect, useState } from 'react';
import type { ProjectInfo, ScaItem, ScaModuleView, ScaScope, ScaView, Severity } from '../../shared/types';
import { SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { INVENTORY_STATUS, JOB_STATUS, kTokens, SCA_STATUS, SEVERITY, time } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { IconButton } from './Icon';
import { tr } from '../i18n';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  notify: (level: 'info' | 'warn' | 'error', text: string) => void;
}

const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, SEVERITIES.length - i])) as Record<Severity, number>;

export const scaItemKey = (x: Pick<ScaItem, 'moduleId' | 'packageKey' | 'vulnId'>) => `${x.moduleId}/${x.packageKey}#${x.vulnId}`;

/** Asks for confirmation with the dry-run estimate (prefilter + AI sessions), then runs reachability. */
export async function confirmSca(
  project: ProjectInfo,
  run: RunFn,
  o: { scope?: ScaScope; moduleIds?: string[]; items?: string[] },
  notify?: Props['notify'],
): Promise<void> {
  const e = await run(api.estimateSca(project.id, o));
  if (!e) return;
  if (!e.items) {
    notify?.('warn', e.busy ? tr('All selected items are already queued ({n}).', { n: e.busy }) : tr('No SCA items to check.'));
    return;
  }
  const over = e.tokensPerSession > e.maxTokensPerRun ? ` ${tr('The session estimate exceeds the limit of {limit}!', { limit: kTokens(e.maxTokensPerRun) })}` : '';
  const text =
    tr('Reachability: items {items}; closed by the prefilter without AI: {auto}; AI sessions {sessions} (one per package), ≈{tokens} tokens ({source})', {
      items: e.items,
      auto: e.auto,
      sessions: e.sessions,
      tokens: kTokens(e.tokens),
      source: e.tokensPerSessionSource === 'history' ? tr('from history') : tr('from config'),
    }) + `${e.busy ? `, ${tr('already queued: {n}', { n: e.busy })}` : ''}.${over} ${tr('Run?')}`;
  if (!confirm(text)) return;
  const r = await run(api.runSca(project.id, o));
  if (r) notify?.('info', tr('Prefilter closed items: {auto}; sessions queued: {n}.', { auto: r.auto, n: r.jobs.length }));
}

function InventoryRow({ m, project, run, onSelect }: { m: ScaModuleView } & Pick<Props, 'project' | 'run' | 'onSelect'>) {
  const inv = m.inventory;
  const job = m.inventoryJob;
  return (
    <tr>
      <td>
        <strong>{m.module.name}</strong>
      </td>
      <td>
        {inv ? (
          <>
            <span className={`status ${inv.status === 'complete' ? 'r-succeeded' : 'r-failed'}`}>{INVENTORY_STATUS[inv.status]}</span>{' '}
            <span className="mono small">{inv.commitSha.slice(0, 8)}</span>
            {m.inventoryStale && <span className="status stale">{tr('stale|map')}</span>}
            <div className="muted small">
              {time(inv.finishedAt)} · <a onClick={() => onSelect({ kind: 'run', id: inv.runId })}>{tr('run')}</a>
            </div>
          </>
        ) : (
          <span className="muted">{tr('no')}</span>
        )}
      </td>
      <td className="small">
        {inv?.summary ? (
          <>
            {inv.summary.ecosystems.join(', ')} · {inv.summary.tools.join(', ')}
            <div className="muted">
              {tr('dependencies {deps}, vulnerable packages {packages}, vulnerabilities {vulns}', { deps: inv.summary.dependenciesTotal, packages: inv.packageCount, vulns: inv.vulnCount })}
            </div>
            {inv.summary.notes && <div className="muted prewrap">{inv.summary.notes}</div>}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="small">
        {job && (
          <span className={`status s-${job.status}`} title={job.error ?? ''}>
            {JOB_STATUS[job.status]}
          </span>
        )}
        {m.failedJob && (
          <a className="error-text" title={m.failedJob.error ?? ''} onClick={() => onSelect({ kind: 'job', id: m.failedJob!.id })}>
            {tr('last inventory failed')}
          </a>
        )}
      </td>
      <td className="actions">
        <IconButton
          icon={inv ? 'recheck' : 'package'}
          title={inv ? tr('Repeat the module inventory') : tr('Module inventory')}
          disabled={Boolean(job)}
          onClick={() => void run(api.enqueueScaInventories(project.id, [m.module.id]))}
        />
      </td>
    </tr>
  );
}

function Inputs({ project, run, view }: Pick<Props, 'project' | 'run'> & { view: ScaView }) {
  const [moduleId, setModuleId] = useState('');
  const [note, setNote] = useState('');
  const [removed, setRemoved] = useState(false);
  const upload = async () => {
    const file = await run(api.pickScaInputFile());
    if (!file) return;
    if (await run(api.addScaInput(project.id, file, { moduleId: moduleId || null, note }))) setNote('');
  };
  const moduleName = (id: string | null) => (id ? (view.modules.find((m) => m.module.id === id)?.module.name ?? id.slice(0, 8)) : tr('whole project'));
  const shown = view.inputs.filter((i) => removed || !i.removedAt);
  return (
    <details className="sca-inputs">
      <summary>{tr('Uploaded dependency files ({n})', { n: view.inputs.filter((i) => !i.removedAt).length })}</summary>
      <p className="muted small">
        {tr('Lock files, SBOMs, scanner reports: they are passed to the inventory agent of the next run (of the module or the whole project).')}
      </p>
      <div className="toolbar">
        <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">{tr('whole project')}</option>
          {view.modules.map((m) => (
            <option key={m.module.id} value={m.module.id}>
              {m.module.name}
            </option>
          ))}
        </select>
        <input placeholder={tr('comment (what this file is)')} value={note} onChange={(e) => setNote(e.target.value)} />
        <IconButton icon="upload" title={tr('Upload a lock file, SBOM or report')} label={tr('Upload')} onClick={() => void upload()} />
        <label className="check">
          <input type="checkbox" checked={removed} onChange={(e) => setRemoved(e.target.checked)} /> {tr('show excluded')}
        </label>
      </div>
      {shown.length > 0 && (
        <table className="grid compact">
          <tbody>
            {shown.map((i) => (
              <tr key={i.id} className={i.removedAt ? 'removed' : ''}>
                <td className="mono small">{i.filename}</td>
                <td>{moduleName(i.moduleId)}</td>
                <td className="small">{i.note || '—'}</td>
                <td className="small muted">
                  {i.author} · {time(i.createdAt)}
                  {i.removedAt && <div>{tr('excluded: {by}', { by: i.removedBy ?? '' })}</div>}
                </td>
                <td className="actions">
                  {!i.removedAt && <IconButton icon="trash" title={tr('Exclude the file')} onClick={() => void run(api.removeScaInput(project.id, i.id))} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

export function ScaTab({ project, revision, run, selection, onSelect, notify }: Props) {
  const [view, setView] = useState<ScaView | null>(null);
  const [moduleId, setModuleId] = useState('');
  const [stale, setStale] = useState(false);
  const [direct, setDirect] = useState(false);

  useEffect(() => {
    void run(api.scaView(project.id)).then((v) => v && setView(v));
  }, [project.id, revision, run]);

  const mods = (view?.modules ?? []).filter((m) => !moduleId || m.module.id === moduleId);
  const moduleIds = moduleId ? [moduleId] : undefined;
  const all = mods.flatMap((m) => m.items);
  const count = (f: (x: ScaItem) => boolean) => all.filter(f).length;
  const moduleName = (id: string) => view?.modules.find((m) => m.module.id === id)?.module.name ?? id.slice(0, 8);
  const inv = useGrid('sca.inventory', mods, [
    { key: 'module', title: tr('Module'), text: (m) => m.module.name },
    { key: 'inventory', title: tr('Inventory'), text: (m) => (m.inventory ? INVENTORY_STATUS[m.inventory.status] : tr('no')), filter: 'enum' },
    { key: 'summary', title: tr('Tools and summary'), text: (m) => (m.inventory?.summary ? `${m.inventory.summary.ecosystems.join(' ')} ${m.inventory.summary.tools.join(' ')}` : '') },
    { key: 'job', title: tr('Job'), text: (m) => (m.inventoryJob ? JOB_STATUS[m.inventoryJob.status] : m.failedJob ? tr('failed') : ''), filter: 'enum' },
    { key: 'actions', title: '', className: 'actions' },
  ]);
  const g = useGrid(
    'sca.items',
    all.filter((x) => (!stale || x.stale) && (!direct || x.direct)),
    [
      { key: 'package', title: tr('Package'), text: (x) => `${x.name}@${x.version} ${x.ecosystem}`, sort: (x) => x.name },
      { key: 'vuln', title: tr('Vulnerability'), text: (x) => `${x.vulnId} ${x.vuln.title ?? ''}`, sort: (x) => x.vulnId },
      { key: 'severity', title: 'Severity', text: (x) => SEVERITY[x.vuln.severity], sort: (x) => -SEV_RANK[x.vuln.severity], filter: 'enum' },
      { key: 'fixed', title: tr('Fixed in'), text: (x) => x.vuln.fixedVersion ?? '—' },
      { key: 'status', title: tr('Reachability'), text: (x) => SCA_STATUS[x.status], filter: 'enum' },
      { key: 'module', title: tr('Module'), text: (x) => moduleName(x.moduleId), filter: 'enum' },
    ],
  );
  // Without a chosen sort the worst vulnerabilities lead.
  const items = g.sorted ? g.rows : [...g.rows].sort((a, b) => SEV_RANK[b.vuln.severity] - SEV_RANK[a.vuln.severity] || a.name.localeCompare(b.name));

  if (!view) return null;
  if (!view.modules.length) return <div className="empty">{tr('Mark up modules first: SCA is built per module.')}</div>;

  return (
    <div className="signals-tab sca-tab">
      <div className="toolbar">
        <select aria-label={tr('Run scope')} value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">{tr('all modules')}</option>
          {view.modules.map((m) => (
            <option key={m.module.id} value={m.module.id}>
              {m.module.name}
            </option>
          ))}
        </select>
        <span className="toolbar-group">
          <IconButton
            icon="package"
            title={tr('Dependency inventory: {scope}', { scope: moduleId ? tr('selected module') : tr('all modules') })}
            label={tr('Inventory')}
            onClick={() => void run(api.enqueueScaInventories(project.id, moduleIds))}
          />
          <IconButton
            icon="play"
            className="primary"
            title={tr('Check the reachability of unchecked items')}
            label={`${tr('Reachability')} ${count((x) => x.status === 'not_checked')}`}
            disabled={!count((x) => x.status === 'not_checked')}
            onClick={() => void confirmSca(project, run, { scope: 'pending', moduleIds }, notify)}
          />
          <IconButton
            icon="recheck"
            title={tr('Recheck stale items')}
            label={`${tr('Stale')} ${count((x) => x.stale)}`}
            disabled={!count((x) => x.stale)}
            onClick={() => void confirmSca(project, run, { scope: 'stale', moduleIds }, notify)}
          />
        </span>
      </div>
      {inv.count && <div className="toolbar">{inv.count}</div>}
      <table className="grid compact">
        {inv.head}
        <tbody>
          {inv.rows.length === 0 && <EmptyRow colSpan={inv.colSpan} filtered={inv.filtered}>—</EmptyRow>}
          {inv.rows.map((m) => (
            <InventoryRow key={m.module.id} m={m} project={project} run={run} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
      <Inputs project={project} run={run} view={view} />

      <div className="grid-title">
        <h3>{tr('Vulnerable dependencies')}</h3>
        <label className="check">
          <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} /> {tr('direct only')}
        </label>
        <label className="check">
          <input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} /> {tr('stale only')}
        </label>
        {g.count}
      </div>
      <table className="grid">
        {g.head}
        <tbody>
          {items.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered || stale || direct}>
              {tr('No vulnerable dependencies, or no inventory yet')}
            </EmptyRow>
          )}
          {items.map((x) => {
            const id = scaItemKey(x);
            return (
              <tr key={id} className={selection?.kind === 'sca' && selection.id === id ? 'selected' : ''} onClick={() => onSelect({ kind: 'sca', id })}>
                <td>
                  <span className="mono small">
                    {x.name}@{x.version}
                  </span>
                  <div className="muted small">
                    {x.ecosystem} · {x.direct === null ? tr('direct?') : x.direct ? tr('direct') : tr('transitive')}
                  </div>
                </td>
                <td>
                  <span className="mono small">{x.vulnId}</span>
                  {x.vuln.title && <div className="muted small">{x.vuln.title}</div>}
                </td>
                <td>
                  <span className={`status sev-${x.vuln.severity}`}>{SEVERITY[x.vuln.severity]}</span>
                </td>
                <td className="mono small">{x.vuln.fixedVersion ?? '—'}</td>
                <td>
                  <span className={`status ss-${x.status}`}>{SCA_STATUS[x.status]}</span>
                  {x.verdict?.author === 'auto' && <span className="muted small"> (auto)</span>}
                  {x.stale && <span className="status stale">{tr('stale')}</span>}
                  {x.findingCount > 0 && <span className="muted small"> · {tr('findings: {n}', { n: x.findingCount })}</span>}
                  {x.activeJob && <div className="muted small">{JOB_STATUS[x.activeJob.status]}</div>}
                </td>
                <td>{moduleName(x.moduleId)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
