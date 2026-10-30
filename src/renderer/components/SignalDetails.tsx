import { useEffect, useState } from 'react';
import type { ModuleSummary, ProjectInfo, SignalDetails, SuppressionScope, SuppressionView } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { SCAN_STATUS, SEVERITY, SIGNAL_KIND, SUPPRESSION_SCOPE, SUPPRESSION_STATE, time } from '../format';
import type { Selection } from './DetailsPanel';
import { IconButton } from './Icon';
import { Section } from './Section';
import { tr } from '../i18n';

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
        <legend>{tr('What to suppress')}</legend>
        <label className="check">
          <input type="radio" checked={scope === 'finding'} onChange={() => setScope('finding')} /> {tr('this signal')} ({signal.file}
          {signal.line ? `:${signal.line}` : ''})
        </label>
        <label className="check">
          <input type="radio" checked={scope === 'rule_glob'} onChange={() => setScope('rule_glob')} /> {tr('rule')} <span className="mono small">{signal.ruleId}</span> {tr('in files')}
        </label>
      </fieldset>
      {scope === 'rule_glob' && (
        <label>
          {tr('Globs (one per line, from the repository root)')}
          <textarea rows={2} className="mono" value={globs} onChange={(e) => setGlobs(e.target.value)} />
        </label>
      )}
      <label>
        {tr('Reason (required)')}
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label>
        {tr('Expires (optional)')}
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <div className="row">
        <button className="primary" disabled={!reason.trim() || (scope === 'rule_glob' && !globs.trim())} onClick={() => void save()}>
          {tr('Suppress')}
        </button>
        <button onClick={onDone}>{tr('Cancel')}</button>
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
        <dt>{tr('Scanner')}</dt>
        <dd>
          {s.scanner} <span className="mono small">{s.ruleId}</span>
        </dd>
        <dt>{tr('File')}</dt>
        <dd>
          <a className="mono small" onClick={() => void run(api.openInEditor(s.file, s.line ?? undefined, project.id))}>
            {s.file}
            {s.line ? `:${s.line}` : ''}
            {s.endLine && s.endLine !== s.line ? `–${s.endLine}` : ''}
          </a>
        </dd>
        <dt>{tr('Modules')}</dt>
        <dd>{s.moduleIds.map((m) => modules.find((x) => x.id === m)?.name ?? m.slice(0, 8)).join(', ') || '—'}</dd>
        {s.cwe.length > 0 && (
          <>
            <dt>CWE</dt>
            <dd>{s.cwe.join(', ')}</dd>
          </>
        )}
        <dt>{tr('Scan|noun')}</dt>
        <dd>
          {SCAN_STATUS[d.scan.status]} · <span className="mono">{d.scan.commitSha.slice(0, 8)}</span> · {d.scan.toolVersion ?? ''} · {time(d.scan.finishedAt)}
        </dd>
        <dt>{tr('Fingerprint')}</dt>
        <dd className="mono small">{s.fingerprint.slice(0, 16)}</dd>
      </dl>
      <div className="prewrap">{s.message}</div>
      {s.snippet && <pre>{s.snippet}</pre>}
      {data.length > 0 && (
        <details>
          <summary>{tr('Scanner data')}</summary>
          <pre>{JSON.stringify(Object.fromEntries(data), null, 2)}</pre>
        </details>
      )}
      <div className="actions">
        <IconButton icon="suppress" className="primary" title={tr('Suppress the signal')} label={tr('Suppress')} disabled={form} onClick={() => setForm(true)} />
      </div>
      {form && <SuppressForm project={project} run={run} signal={s} onDone={() => setForm(false)} />}
      <Section title={tr('Suppressions')}>
        {d.suppressions.length === 0 ? <div className="muted">{tr('none')}</div> : d.suppressions.map((x) => <SuppressionLine key={x.id} s={x} onSelect={onSelect} />)}
      </Section>
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
  if (!s) return list.length ? <div className="muted">{tr('Suppression not found')}</div> : null;
  const successor = list.find((x) => x.replaces === s.id);

  const renew = async () => {
    // Without a new date the current expiry is kept (if still in the future).
    const n = await run(expires ? api.renewSuppression(project.id, s.id, expires) : api.renewSuppression(project.id, s.id));
    if (n) onSelect({ kind: 'suppression', id: n.id });
  };

  return (
    <section>
      <h3>{tr('Suppression')}</h3>
      <dl>
        <dt>{tr('State')}</dt>
        <dd>
          <span className={`status sup-${s.state}`}>{SUPPRESSION_STATE[s.state]}</span> <span className="muted small">{tr('at HEAD')}</span>
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
        <dt>{tr('Reason')}</dt>
        <dd className="prewrap">{s.reason}</dd>
        <dt>{tr('Author')}</dt>
        <dd>
          {s.author} · {time(s.createdAt)}
        </dd>
        <dt>{tr('Commit')}</dt>
        <dd className="mono">{s.commitSha.slice(0, 12)}</dd>
        <dt>{tr('Expires')}</dt>
        <dd>{s.expiresAt ?? '—'}</dd>
        <dt>{tr('Depends on')}</dt>
        <dd className="mono small">
          {s.touchedFiles.length || s.moduleGlobs.length
            ? [...s.touchedFiles, ...s.moduleGlobs.map((g) => `glob ${g}`)].map((f) => <div key={f}>{f}</div>)
            : '—'}
        </dd>
        {s.changedFiles.length > 0 && (
          <>
            <dt>{tr('Changed|files')}</dt>
            <dd className="mono small warn">
              {s.changedFiles.map((f) => (
                <div key={f}>{f}</div>
              ))}
            </dd>
          </>
        )}
        {s.replaces && (
          <>
            <dt>{tr('Replaces')}</dt>
            <dd>
              <a onClick={() => onSelect({ kind: 'suppression', id: s.replaces! })}>{tr('previous suppression')}</a>
            </dd>
          </>
        )}
        {s.revokedAt && (
          <>
            <dt>{tr('Revoked')}</dt>
            <dd>
              {s.revokedBy} · {time(s.revokedAt)}: {s.revokeReason}
              {successor && (
                <>
                  {' '}
                  · <a onClick={() => onSelect({ kind: 'suppression', id: successor.id })}>{tr('new|suppression')}</a>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      {!s.revokedAt && (
        <>
          <div className="actions">
            <input type="date" title={tr('new expiry date (optional)')} value={expires} onChange={(e) => setExpires(e.target.value)} />
            <IconButton icon="check" className={s.state === 'active' ? '' : 'primary'} title={tr('Confirm the suppression at HEAD')} label={tr('Confirm')} onClick={() => void renew()} />
          </div>
          <div className="actions">
            <input placeholder={tr('reason for revoking')} value={reason} onChange={(e) => setReason(e.target.value)} />
            <IconButton icon="undo" className="danger" title={tr('Revoke the suppression (a reason is required)')} label={tr('Revoke')} disabled={!reason.trim()} onClick={() => void run(api.revokeSuppression(project.id, s.id, reason))} />
          </div>
        </>
      )}
    </section>
  );
}
