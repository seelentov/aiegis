import { useEffect, useState } from 'react';
import type { Job, ModuleSummary, ProjectInfo, RequirementItem, Scan, ScannerStatus, Severity, SignalsView, SuppressionView } from '../../shared/types';
import { SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { JOB_STATUS, SCAN_STATUS, SEVERITY, SIGNAL_KIND, SUPPRESSION_SCOPE, SUPPRESSION_STATE, time } from '../format';
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

type View = 'signals' | 'suppressions' | 'scans';

const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, SEVERITIES.length - i])) as Record<Severity, number>;

/** Scanner availability (checked at startup) and scan buttons. */
function ScannerBar({ project, run, notify, revision }: Pick<Props, 'project' | 'run' | 'notify' | 'revision'>) {
  const [status, setStatus] = useState<ScannerStatus[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    void run(api.scannerStatus(project.id)).then((s) => s && setStatus(s));
  }, [project.id, run]);
  useEffect(() => {
    void api.listJobs(project.id).then((js) => setJobs(js.filter((j) => j.type === 'scan' && (j.status === 'queued' || j.status === 'running'))));
  }, [project.id, revision]);
  const scan = async (moduleIds: string[] | null) => {
    const r = await run(api.runScanners(project.id, { moduleIds }));
    if (!r) return;
    const parts = [
      r.jobs.length ? tr('queued: {list}', { list: r.jobs.map((j) => j.role).join(', ') }) : '',
      r.cached.length ? tr('already done for this commit: {list}', { list: r.cached.join(', ') }) : '',
      r.unavailable.length ? tr('unavailable: {list}', { list: r.unavailable.join(', ') }) : '',
    ].filter(Boolean);
    notify(r.jobs.length ? 'info' : 'warn', tr('Scan: {result}', { result: parts.join('; ') || tr('no scanners enabled') }));
  };
  return (
    <div className="toolbar">
      {status.map((s) => (
        <span key={s.name} className={`status ${s.available ? 'r-succeeded' : s.enabled ? 'r-failed' : ''}`} title={s.error ?? `${s.binary} · ${s.format}`}>
          {s.name} {s.available ? (s.version ?? '') : s.enabled ? tr('unavailable|scanner') : tr('disabled')}
        </span>
      ))}
      <IconButton icon="recheck" title={tr('Check scanner availability again')} onClick={() => void run(api.scannerStatus(project.id, true)).then((s) => s && setStatus(s))} />
      <span className="toolbar-group">
        <IconButton icon="scan" className="primary" title={tr('Scan the files of all modules')} label={tr('Modules')} onClick={() => void scan([])} />
        <IconButton icon="scan" title={tr('Scan the whole repository')} label={tr('Repository')} onClick={() => void scan(null)} />
      </span>
      {jobs.map((j) => (
        <span key={j.id} className={`status s-${j.status}`} title={j.title}>
          {j.role}: {JOB_STATUS[j.status]}
        </span>
      ))}
    </div>
  );
}

function SignalsList({ project, revision, run, selection, onSelect, modules }: Props & { modules: ModuleSummary[] }) {
  const [view, setView] = useState<SignalsView | null>(null);
  const [commit, setCommit] = useState<string | null>(null);
  const [suppressed, setSuppressed] = useState(false);

  useEffect(() => {
    void run(api.signalsView(project.id, commit)).then((v) => v && setView(v));
  }, [project.id, commit, revision, run]);

  const moduleName = (id: string) => modules.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  const g = useGrid(
    'signals',
    (view?.signals ?? []).filter((s) => suppressed || s.suppression?.state !== 'active'),
    [
      { key: 'severity', title: 'Severity', text: (s) => SEVERITY[s.severity], sort: (s) => -SEV_RANK[s.severity], filter: 'enum' },
      { key: 'signal', title: tr('Signal'), text: (s) => `${s.title} ${s.message}`, sort: (s) => s.title },
      { key: 'kind', title: tr('Kind'), text: (s) => SIGNAL_KIND[s.kind], filter: 'enum' },
      { key: 'file', title: tr('File'), text: (s) => `${s.file}${s.line ? `:${s.line}` : ''}`, sort: (s) => s.file },
      { key: 'module', title: tr('Module'), text: (s) => s.moduleIds.map(moduleName).join(', ') || tr('outside modules'), filter: 'enum' },
      { key: 'scanner', title: tr('Scanner'), text: (s) => s.scanner, filter: 'enum' },
    ],
  );

  if (!view) return null;
  if (!view.commit) return <div className="empty">{tr('No scans yet. Run the scanners with the button above or matrix verdicts (scans are queued automatically).')}</div>;

  return (
    <>
      <div className="toolbar">
        <label>
          {tr('Commit')}{' '}
          <select value={view.commit} onChange={(e) => setCommit(e.target.value)}>
            {view.commits.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.sha.slice(0, 8)}
                {c.sha === view.head ? ' (HEAD)' : ''} · {tr('scans {n}', { n: c.scans })}
              </option>
            ))}
          </select>
        </label>
        {view.commit !== view.head && <span className="warn">{tr('not HEAD: lines in the editor may differ')}</span>}
        <label className="check">
          <input type="checkbox" checked={suppressed} onChange={(e) => setSuppressed(e.target.checked)} /> {tr('show suppressed')}
        </label>
        <span className="muted">
          {tr('{n} of {total}', { n: g.rows.length, total: view.signals.length })}
        </span>
        {g.count}
      </div>
      <table className="grid signal-grid">
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {tr('No signals')}
            </EmptyRow>
          )}
          {g.rows.map((s) => (
            <tr
              key={s.id}
              className={selection?.kind === 'signal' && selection.id === s.id ? 'selected' : s.suppression?.state === 'active' ? 'removed' : ''}
              onClick={() => onSelect({ kind: 'signal', id: s.id })}
            >
              <td>
                <span className={`status sev-${s.severity}`}>{SEVERITY[s.severity]}</span>
              </td>
              <td>
                <strong>{s.title}</strong>
                <div className="small muted clip">{s.message}</div>
                {s.suppression && (
                  <span className={`status sup-${s.suppression.state}`} title={s.suppression.reason}>
                    {tr('suppressed: {state}', { state: SUPPRESSION_STATE[s.suppression.state] })}
                  </span>
                )}
              </td>
              <td className="small">{SIGNAL_KIND[s.kind]}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <a className="mono small" onClick={() => void run(api.openInEditor(s.file, s.line ?? undefined, project.id))}>
                  {s.file}
                  {s.line ? `:${s.line}` : ''}
                </a>
              </td>
              <td>{s.moduleIds.map(moduleName).join(', ') || <span className="muted">—</span>}</td>
              <td className="mono small">
                {s.scanner}
                <div className="muted" title={s.ruleId}>{s.ruleId}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RequirementModuleForm({ project, run, modules, onDone }: { project: ProjectInfo; run: RunFn; modules: ModuleSummary[]; onDone: () => void }) {
  const [reqs, setReqs] = useState<(RequirementItem & { documentTitle: string })[]>([]);
  const [requirementId, setRequirementId] = useState('');
  const [moduleId, setModuleId] = useState('');
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  useEffect(() => {
    void run(api.currentRequirements(project.id)).then((r) => r && setReqs(r));
  }, [project.id, run]);
  const save = async () => {
    const ok = await run(api.createSuppression(project.id, { scope: 'requirement_module', requirementId, moduleId, reason, expiresAt: expires || null }));
    if (ok) onDone();
  };
  return (
    <div className="form">
      <label>
        {tr('Item')}
        <select value={requirementId} onChange={(e) => setRequirementId(e.target.value)}>
          <option value="">—</option>
          {reqs.map((r) => (
            <option key={r.requirementId} value={r.requirementId}>
              {r.key}: {r.text.slice(0, 80)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {tr('Module')}
        <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">—</option>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        {tr('Reason (required)')}
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label>
        {tr('Expires (optional)')}
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <div className="row">
        <IconButton icon="suppress" className="primary" title={tr('Suppress the signals of the item in the module')} label={tr('Suppress')} disabled={!requirementId || !moduleId || !reason.trim()} onClick={() => void save()} />
        <button onClick={onDone}>{tr('Cancel')}</button>
      </div>
    </div>
  );
}

function SuppressionsList({ project, revision, run, selection, onSelect, modules }: Props & { modules: ModuleSummary[] }) {
  const [list, setList] = useState<SuppressionView[]>([]);
  const [revoked, setRevoked] = useState(false);
  const [form, setForm] = useState(false);
  useEffect(() => {
    void run(api.listSuppressions(project.id)).then((l) => l && setList(l));
  }, [project.id, revision, run]);
  const g = useGrid(
    'suppressions',
    list.filter((s) => revoked || s.state !== 'revoked'),
    [
      { key: 'state', title: tr('State'), text: (s) => SUPPRESSION_STATE[s.state], filter: 'enum' },
      { key: 'scope', title: 'Scope', text: (s) => `${SUPPRESSION_SCOPE[s.scope]} ${s.label}`, sort: (s) => s.label },
      { key: 'reason', title: tr('Reason'), text: (s) => s.reason },
      { key: 'author', title: tr('Author, commit'), text: (s) => `${s.author} ${s.commitSha.slice(0, 8)}`, sort: (s) => s.createdAt },
      { key: 'expires', title: tr('Expires'), text: (s) => s.expiresAt ?? '—' },
    ],
  );
  return (
    <>
      <div className="toolbar">
        <IconButton icon="plus" title={tr('Suppress a requirement item in a module')} label={tr('Item × module')} aria-pressed={form} onClick={() => setForm(!form)} />
        <label className="check">
          <input type="checkbox" checked={revoked} onChange={(e) => setRevoked(e.target.checked)} /> {tr('show revoked')}
        </label>
        <span className="muted">{tr('Finding and rule × glob suppressions are created from a signal (right panel). State is at HEAD.')}</span>
        {g.count}
      </div>
      {form && (
        <div className="card">
          <RequirementModuleForm project={project} run={run} modules={modules} onDone={() => setForm(false)} />
        </div>
      )}
      <table className="grid">
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {tr('No suppressions')}
            </EmptyRow>
          )}
          {g.rows.map((s) => (
            <tr key={s.id} className={selection?.kind === 'suppression' && selection.id === s.id ? 'selected' : s.state === 'revoked' ? 'removed' : ''} onClick={() => onSelect({ kind: 'suppression', id: s.id })}>
              <td>
                <span className={`status sup-${s.state}`}>{SUPPRESSION_STATE[s.state]}</span>
              </td>
              <td>
                <div className="muted small">{SUPPRESSION_SCOPE[s.scope]}</div>
                <span className="mono small">{s.label}</span>
              </td>
              <td className="prewrap">{s.reason}</td>
              <td className="small">
                {s.author}
                <div className="mono muted">
                  {s.commitSha.slice(0, 8)} · {time(s.createdAt)}
                </div>
              </td>
              <td className="small">{s.expiresAt ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ScansList({ project, revision, run }: Pick<Props, 'project' | 'revision' | 'run'>) {
  const [scans, setScans] = useState<Scan[]>([]);
  useEffect(() => {
    void run(api.listScans(project.id)).then((s) => s && setScans(s));
  }, [project.id, revision, run]);
  const g = useGrid('scans', scans, [
    { key: 'status', title: tr('Status'), text: (s) => SCAN_STATUS[s.status], filter: 'enum' },
    { key: 'scanner', title: tr('Scanner'), text: (s) => s.scanner, filter: 'enum' },
    { key: 'commit', title: tr('Commit'), text: (s) => s.commitSha.slice(0, 8) },
    { key: 'targets', title: tr('Paths'), text: (s) => s.targets.join(' ') },
    { key: 'count', title: tr('Results'), text: (s) => String(s.findingCount), sort: (s) => s.findingCount },
    { key: 'time', title: tr('Time'), text: (s) => time(s.startedAt), sort: (s) => s.startedAt },
  ]);
  return (
    <>
    {g.count && <div className="toolbar">{g.count}</div>}
    <table className="grid">
      {g.head}
      <tbody>
        {g.rows.length === 0 && (
          <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
            {tr('No scanner runs')}
          </EmptyRow>
        )}
        {g.rows.map((s) => (
          <tr key={s.id} title={s.commands.map((c) => c.join(' ')).join('\n')}>
            <td>
              <span className={`status scan-${s.status}`}>{SCAN_STATUS[s.status]}</span>
              {s.error && <div className="error-text small">{s.error.slice(0, 300)}</div>}
              {s.warnings.length > 0 && (
                <details className="small" onClick={(e) => e.stopPropagation()}>
                  <summary className="warn">{tr('warnings: {n}', { n: s.warnings.length })}</summary>
                  <ul className="evidence">
                    {s.warnings.map((w) => (
                      <li key={w} className="mono">
                        {w}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </td>
            <td>
              {s.scanner} <span className="muted small">{s.toolVersion ?? ''}</span>
            </td>
            <td className="mono">{s.commitSha.slice(0, 8)}</td>
            <td className="mono small">{s.targets.join(' ')}</td>
            <td>{s.status === 'complete' ? s.findingCount : '—'}</td>
            <td className="small">
              {time(s.startedAt)} → {time(s.finishedAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

export function SignalsTab(props: Props) {
  const [view, setView] = useState<View>('signals');
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  useEffect(() => {
    void api.listModules(props.project.id).then(setModules);
  }, [props.project.id, props.revision]);
  return (
    <div className="signals-tab">
      <ScannerBar project={props.project} run={props.run} notify={props.notify} revision={props.revision} />
      <nav className="subtabs">
        {(
          [
            ['signals', tr('Signals')],
            ['suppressions', tr('Suppressions')],
            ['scans', tr('Scanner runs')],
          ] as const
        ).map(([id, title]) => (
          <button key={id} className={view === id ? 'tab active' : 'tab'} onClick={() => setView(id)}>
            {title}
          </button>
        ))}
      </nav>
      {view === 'signals' ? (
        <SignalsList {...props} modules={modules} />
      ) : view === 'suppressions' ? (
        <SuppressionsList {...props} modules={modules} />
      ) : (
        <ScansList project={props.project} revision={props.revision} run={props.run} />
      )}
    </div>
  );
}
