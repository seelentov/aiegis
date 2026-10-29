import { useEffect, useState } from 'react';
import type { Job, ModuleSummary, ProjectInfo, RequirementItem, Scan, ScannerStatus, Severity, SignalKind, SignalsView, SuppressionView } from '../../shared/types';
import { SEVERITIES, SIGNAL_KINDS } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { JOB_STATUS, SCAN_STATUS, SEVERITY, SIGNAL_KIND, SUPPRESSION_SCOPE, SUPPRESSION_STATE, time } from '../format';
import type { Selection } from './DetailsPanel';

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
      r.jobs.length ? `в очереди: ${r.jobs.map((j) => j.role).join(', ')}` : '',
      r.cached.length ? `уже есть для этого коммита: ${r.cached.join(', ')}` : '',
      r.unavailable.length ? `недоступны: ${r.unavailable.join(', ')}` : '',
    ].filter(Boolean);
    notify(r.jobs.length ? 'info' : 'warn', `Сканирование: ${parts.join('; ') || 'нет включённых сканеров'}`);
  };
  return (
    <div className="toolbar">
      {status.map((s) => (
        <span key={s.name} className={`status ${s.available ? 'r-succeeded' : s.enabled ? 'r-failed' : ''}`} title={s.error ?? `${s.binary} · ${s.format}`}>
          {s.name} {s.available ? (s.version ?? '') : s.enabled ? 'недоступен' : 'выключен'}
        </span>
      ))}
      <button onClick={() => void run(api.scannerStatus(project.id, true)).then((s) => s && setStatus(s))}>Проверить снова</button>
      <button className="primary" onClick={() => void scan([])}>
        Сканировать модули
      </button>
      <button onClick={() => void scan(null)}>Сканировать репозиторий</button>
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
  const [scanner, setScanner] = useState('');
  const [kind, setKind] = useState<SignalKind | ''>('');
  const [moduleId, setModuleId] = useState('');
  const [minSev, setMinSev] = useState<Severity | ''>('');
  const [file, setFile] = useState('');
  const [suppressed, setSuppressed] = useState(false);

  useEffect(() => {
    void run(api.signalsView(project.id, commit)).then((v) => v && setView(v));
  }, [project.id, commit, revision, run]);

  if (!view) return null;
  if (!view.commit) return <div className="empty">Сканов ещё нет. Запустите сканеры кнопкой выше или вердикты матрицы (сканы ставятся автоматически).</div>;
  const scanners = [...new Set(view.signals.map((s) => s.scanner))];
  const shown = view.signals.filter(
    (s) =>
      (suppressed || s.suppression?.state !== 'active') &&
      (!scanner || s.scanner === scanner) &&
      (!kind || s.kind === kind) &&
      (!moduleId || (moduleId === '-' ? !s.moduleIds.length : s.moduleIds.includes(moduleId))) &&
      (!minSev || SEV_RANK[s.severity] >= SEV_RANK[minSev]) &&
      (!file || s.file.includes(file)),
  );
  const moduleName = (id: string) => modules.find((m) => m.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <div className="toolbar">
        <label>
          Коммит{' '}
          <select value={view.commit} onChange={(e) => setCommit(e.target.value)}>
            {view.commits.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.sha.slice(0, 8)}
                {c.sha === view.head ? ' (HEAD)' : ''} · сканов {c.scans}
              </option>
            ))}
          </select>
        </label>
        {view.commit !== view.head && <span className="warn">не HEAD: строки в редакторе могут не совпадать</span>}
        <select value={scanner} onChange={(e) => setScanner(e.target.value)}>
          <option value="">все сканеры</option>
          {scanners.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as SignalKind | '')}>
          <option value="">все виды</option>
          {SIGNAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {SIGNAL_KIND[k]}
            </option>
          ))}
        </select>
        <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">все модули</option>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value="-">вне модулей</option>
        </select>
        <select value={minSev} onChange={(e) => setMinSev(e.target.value as Severity | '')}>
          <option value="">любая severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              ≥ {SEVERITY[s]}
            </option>
          ))}
        </select>
        <input placeholder="файл содержит…" value={file} onChange={(e) => setFile(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={suppressed} onChange={(e) => setSuppressed(e.target.checked)} /> подавленные
        </label>
        <span className="muted">
          {shown.length} из {view.signals.length}
        </span>
      </div>
      <table className="grid signal-grid">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Сигнал</th>
            <th>Файл</th>
            <th>Модуль</th>
            <th>Сканер</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Сигналов нет
              </td>
            </tr>
          )}
          {shown.map((s) => (
            <tr
              key={s.id}
              className={selection?.kind === 'signal' && selection.id === s.id ? 'selected' : s.suppression?.state === 'active' ? 'removed' : ''}
              onClick={() => onSelect({ kind: 'signal', id: s.id })}
            >
              <td>
                <span className={`status sev-${s.severity}`}>{SEVERITY[s.severity]}</span>
              </td>
              <td>
                <strong>{s.title}</strong> <span className="muted small">{SIGNAL_KIND[s.kind]}</span>
                <div className="small muted clip">{s.message}</div>
                {s.suppression && (
                  <span className={`status sup-${s.suppression.state}`} title={s.suppression.reason}>
                    подавлено: {SUPPRESSION_STATE[s.suppression.state]}
                  </span>
                )}
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                <a className="mono small" onClick={() => void run(api.openInEditor(s.file, s.line ?? undefined, project.id))}>
                  {s.file}
                  {s.line ? `:${s.line}` : ''}
                </a>
              </td>
              <td>{s.moduleIds.map(moduleName).join(', ') || <span className="muted">—</span>}</td>
              <td className="mono small">
                {s.scanner}
                <div className="muted">{s.ruleId}</div>
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
        Пункт
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
        Модуль
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
        Причина (обязательно)
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label>
        Срок (необязательно)
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <div className="row">
        <button className="primary" disabled={!requirementId || !moduleId || !reason.trim()} onClick={() => void save()}>
          Подавить
        </button>
        <button onClick={onDone}>Отмена</button>
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
  const shown = list.filter((s) => revoked || s.state !== 'revoked');
  return (
    <>
      <div className="toolbar">
        <button onClick={() => setForm(!form)}>+ Пункт × модуль</button>
        <label className="check">
          <input type="checkbox" checked={revoked} onChange={(e) => setRevoked(e.target.checked)} /> отозванные
        </label>
        <span className="muted">Подавления находки и правила × glob создаются из сигнала (панель справа). Состояние — на HEAD.</span>
      </div>
      {form && (
        <div className="card">
          <RequirementModuleForm project={project} run={run} modules={modules} onDone={() => setForm(false)} />
        </div>
      )}
      <table className="grid">
        <thead>
          <tr>
            <th>Состояние</th>
            <th>Scope</th>
            <th>Причина</th>
            <th>Автор, коммит</th>
            <th>Срок</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Подавлений нет
              </td>
            </tr>
          )}
          {shown.map((s) => (
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
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Статус</th>
          <th>Сканер</th>
          <th>Коммит</th>
          <th>Пути</th>
          <th>Результатов</th>
          <th>Время</th>
        </tr>
      </thead>
      <tbody>
        {scans.length === 0 && (
          <tr>
            <td colSpan={6} className="muted">
              Запусков нет
            </td>
          </tr>
        )}
        {scans.map((s) => (
          <tr key={s.id} title={s.commands.map((c) => c.join(' ')).join('\n')}>
            <td>
              <span className={`status scan-${s.status}`}>{SCAN_STATUS[s.status]}</span>
              {s.error && <div className="error-text small">{s.error.slice(0, 300)}</div>}
              {s.warnings.length > 0 && (
                <details className="small" onClick={(e) => e.stopPropagation()}>
                  <summary className="warn">предупреждений: {s.warnings.length}</summary>
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
            ['signals', 'Сигналы'],
            ['suppressions', 'Подавления'],
            ['scans', 'Запуски сканеров'],
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
