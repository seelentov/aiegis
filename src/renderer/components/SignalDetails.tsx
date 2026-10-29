import { useEffect, useState } from 'react';
import type { ModuleSummary, ProjectInfo, SignalDetails, SuppressionScope, SuppressionView } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { SCAN_STATUS, SEVERITY, SIGNAL_KIND, SUPPRESSION_SCOPE, SUPPRESSION_STATE, time } from '../format';
import type { Selection } from './DetailsPanel';

interface Common {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  onSelect: (s: Selection | null) => void;
}

/** Default glob of a rule × glob suppression: the signal's directory. */
function dirGlob(file: string): string {
  const i = file.lastIndexOf('/');
  return i < 0 ? '*' : `${file.slice(0, i)}/**`;
}

function SuppressForm({ project, run, signal, onDone }: { project: ProjectInfo; run: RunFn; signal: SignalDetails['signal']; onDone: () => void }) {
  const [scope, setScope] = useState<Exclude<SuppressionScope, 'requirement_module'>>('finding');
  const [globs, setGlobs] = useState(dirGlob(signal.file));
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const save = async () => {
    const ok = await run(
      api.createSuppression(project.id, {
        scope,
        signalId: signal.id,
        globs: scope === 'rule_glob' ? globs.split('\n').map((g) => g.trim()).filter(Boolean) : undefined,
        reason,
        expiresAt: expires || null,
      }),
    );
    if (ok) onDone();
  };
  return (
    <div className="form module-form">
      <fieldset>
        <legend>Что подавить</legend>
        <label className="check">
          <input type="radio" checked={scope === 'finding'} onChange={() => setScope('finding')} /> этот сигнал ({signal.file}
          {signal.line ? `:${signal.line}` : ''})
        </label>
        <label className="check">
          <input type="radio" checked={scope === 'rule_glob'} onChange={() => setScope('rule_glob')} /> правило <span className="mono small">{signal.ruleId}</span> в
          файлах
        </label>
      </fieldset>
      {scope === 'rule_glob' && (
        <label>
          Globs (по одному в строке, от корня репозитория)
          <textarea rows={2} className="mono" value={globs} onChange={(e) => setGlobs(e.target.value)} />
        </label>
      )}
      <label>
        Причина (обязательно)
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label>
        Срок (необязательно)
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <div className="row">
        <button className="primary" disabled={!reason.trim() || (scope === 'rule_glob' && !globs.trim())} onClick={() => void save()}>
          Подавить
        </button>
        <button onClick={onDone}>Отмена</button>
      </div>
    </div>
  );
}

function SuppressionLine({ s, onSelect }: { s: SuppressionView; onSelect: Common['onSelect'] }) {
  return (
    <div className="result">
      <div className="row">
        <span className={`status sup-${s.state}`}>{SUPPRESSION_STATE[s.state]}</span>
        <a onClick={() => onSelect({ kind: 'suppression', id: s.id })}>{SUPPRESSION_SCOPE[s.scope]}</a>
        <span className="muted small">
          {s.author} · {s.commitSha.slice(0, 8)} · {time(s.createdAt)}
        </span>
      </div>
      <div className="prewrap">{s.reason}</div>
    </div>
  );
}

export function SignalDetailsView({ project, id, revision, run, onSelect }: Common & { id: string }) {
  const [d, setD] = useState<SignalDetails | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [form, setForm] = useState(false);

  useEffect(() => setForm(false), [id]);
  useEffect(() => {
    void run(api.signalDetails(project.id, id)).then((x) => setD(x ?? null));
    void api.listModules(project.id).then(setModules);
  }, [project.id, id, revision, run]);

  if (!d) return null;
  const s = d.signal;
  const data = Object.entries(s.data).filter(([, v]) => v !== null && v !== undefined && v !== '');
  return (
    <section>
      <h3>{s.title}</h3>
      <dl>
        <dt>Severity</dt>
        <dd>
          <span className={`status sev-${s.severity}`}>{SEVERITY[s.severity]}</span> {SIGNAL_KIND[s.kind]}
        </dd>
        <dt>Сканер</dt>
        <dd>
          {s.scanner} <span className="mono small">{s.ruleId}</span>
        </dd>
        <dt>Файл</dt>
        <dd>
          <a className="mono small" onClick={() => void run(api.openInEditor(s.file, s.line ?? undefined, project.id))}>
            {s.file}
            {s.line ? `:${s.line}` : ''}
            {s.endLine && s.endLine !== s.line ? `–${s.endLine}` : ''}
          </a>
        </dd>
        <dt>Модули</dt>
        <dd>{s.moduleIds.map((m) => modules.find((x) => x.id === m)?.name ?? m.slice(0, 8)).join(', ') || '—'}</dd>
        {s.cwe.length > 0 && (
          <>
            <dt>CWE</dt>
            <dd>{s.cwe.join(', ')}</dd>
          </>
        )}
        <dt>Скан</dt>
        <dd>
          {SCAN_STATUS[d.scan.status]} · <span className="mono">{d.scan.commitSha.slice(0, 8)}</span> · {d.scan.toolVersion ?? ''} · {time(d.scan.finishedAt)}
        </dd>
        <dt>Отпечаток</dt>
        <dd className="mono small">{s.fingerprint.slice(0, 16)}</dd>
      </dl>
      <div className="prewrap">{s.message}</div>
      {s.snippet && <pre>{s.snippet}</pre>}
      {data.length > 0 && (
        <details>
          <summary>Данные сканера</summary>
          <pre>{JSON.stringify(Object.fromEntries(data), null, 2)}</pre>
        </details>
      )}
      <div className="actions">
        <button className="primary" disabled={form} onClick={() => setForm(true)}>
          Подавить…
        </button>
      </div>
      {form && <SuppressForm project={project} run={run} signal={s} onDone={() => setForm(false)} />}
      <h4>Подавления</h4>
      {d.suppressions.length === 0 ? <div className="muted">нет</div> : d.suppressions.map((x) => <SuppressionLine key={x.id} s={x} onSelect={onSelect} />)}
    </section>
  );
}

export function SuppressionDetailsView({ project, id, revision, run, onSelect }: Common & { id: string }) {
  const [list, setList] = useState<SuppressionView[]>([]);
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');

  useEffect(() => {
    setReason('');
    setExpires('');
  }, [id]);
  useEffect(() => {
    void run(api.listSuppressions(project.id)).then((l) => l && setList(l));
  }, [project.id, id, revision, run]);

  const s = list.find((x) => x.id === id);
  if (!s) return list.length ? <div className="muted">Подавление не найдено</div> : null;
  const successor = list.find((x) => x.replaces === s.id);

  const renew = async () => {
    // Without a new date the current expiry is kept (if still in the future).
    const n = await run(expires ? api.renewSuppression(project.id, s.id, expires) : api.renewSuppression(project.id, s.id));
    if (n) onSelect({ kind: 'suppression', id: n.id });
  };

  return (
    <section>
      <h3>Подавление</h3>
      <dl>
        <dt>Состояние</dt>
        <dd>
          <span className={`status sup-${s.state}`}>{SUPPRESSION_STATE[s.state]}</span> <span className="muted small">на HEAD</span>
        </dd>
        <dt>Scope</dt>
        <dd>
          {SUPPRESSION_SCOPE[s.scope]}: <span className="mono small">{s.label}</span>
        </dd>
        {s.globs.length > 0 && (
          <>
            <dt>Globs</dt>
            <dd className="mono small">
              {s.globs.map((g) => (
                <div key={g}>{g}</div>
              ))}
            </dd>
          </>
        )}
        <dt>Причина</dt>
        <dd className="prewrap">{s.reason}</dd>
        <dt>Автор</dt>
        <dd>
          {s.author} · {time(s.createdAt)}
        </dd>
        <dt>Коммит</dt>
        <dd className="mono">{s.commitSha.slice(0, 12)}</dd>
        <dt>Срок</dt>
        <dd>{s.expiresAt ?? '—'}</dd>
        <dt>Зависит от</dt>
        <dd className="mono small">
          {s.touchedFiles.length || s.moduleGlobs.length
            ? [...s.touchedFiles, ...s.moduleGlobs.map((g) => `glob ${g}`)].map((f) => <div key={f}>{f}</div>)
            : '—'}
        </dd>
        {s.changedFiles.length > 0 && (
          <>
            <dt>Изменились</dt>
            <dd className="mono small warn">
              {s.changedFiles.map((f) => (
                <div key={f}>{f}</div>
              ))}
            </dd>
          </>
        )}
        {s.replaces && (
          <>
            <dt>Заменяет</dt>
            <dd>
              <a onClick={() => onSelect({ kind: 'suppression', id: s.replaces! })}>предыдущее подавление</a>
            </dd>
          </>
        )}
        {s.revokedAt && (
          <>
            <dt>Отозвано</dt>
            <dd>
              {s.revokedBy} · {time(s.revokedAt)}: {s.revokeReason}
              {successor && (
                <>
                  {' '}
                  · <a onClick={() => onSelect({ kind: 'suppression', id: successor.id })}>новое</a>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      {!s.revokedAt && (
        <>
          <div className="actions">
            <input type="date" title="новый срок (необязательно)" value={expires} onChange={(e) => setExpires(e.target.value)} />
            <button className={s.state === 'active' ? '' : 'primary'} onClick={() => void renew()}>
              Подтвердить на HEAD
            </button>
          </div>
          <div className="actions">
            <input placeholder="причина отзыва" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button disabled={!reason.trim()} onClick={() => void run(api.revokeSuppression(project.id, s.id, reason))}>
              Отозвать
            </button>
          </div>
        </>
      )}
    </section>
  );
}
