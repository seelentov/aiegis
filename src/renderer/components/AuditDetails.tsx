import { useEffect, useState } from 'react';
import type { CellDetails, Evidence, Finding, FindingDetails, FindingStatus, ProjectInfo, Severity, Verdict, VerdictStatus } from '../../shared/types';
import { FINDING_STATUSES, SEVERITIES, VERDICT_STATUSES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { CELL_STATUS, FINDING_STATUS, kTokens, POC_OUTCOME, SEVERITY, STALE_REASON, time } from '../format';
import { ConfigView } from './ConfigView';
import type { Selection } from './DetailsPanel';
import { IconButton } from './Icon';
import { Section } from './Section';
import { tr } from '../i18n';

interface Common {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  onSelect: (s: Selection | null) => void;
  onTerminal: (id: string | undefined) => void;
}

/** "path[:line] [note]" per line. */
export function parseEvidence(text: string): Evidence[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\S+?)(?::(\d+))?(?:\s+(.*))?$/.exec(l)!;
      return { file: m[1], ...(m[2] ? { line: Number(m[2]) } : {}), ...(m[3] ? { note: m[3] } : {}) };
    });
}

export function EvidenceList({ project, run, items }: { project: ProjectInfo; run: RunFn; items: Evidence[] }) {
  if (!items.length) return <span className="muted">—</span>;
  return (
    <ul className="evidence">
      {items.map((e, i) => (
        <li key={i}>
          <a className="mono small" onClick={() => void run(api.openInEditor(e.file, e.line, project.id))}>
            {e.file}
            {e.line ? `:${e.line}` : ''}
          </a>
          {e.note && <span className="muted"> — {e.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Asks for confirmation with the dry-run estimate, then queues re-checks. */
export async function confirmRecheck(project: ProjectInfo, run: RunFn, cells: string[], matrixId?: string): Promise<void> {
  const e = await run(api.estimateRecheck(project.id, cells, matrixId));
  if (!e) return;
  const text =
    tr('Recheck: sessions {sessions}, cells {cells}, ≈{tokens} tokens ({source})', {
      sessions: e.sessions,
      cells: e.cells,
      tokens: kTokens(e.tokens),
      source: e.tokensPerCellSource === 'history' ? tr('from history') : tr('from config'),
    }) + `${e.busy ? `, ${tr('already queued: {n}', { n: e.busy })}` : ''}. ${tr('Run?')}`;
  if (e.cells && confirm(text)) await run(api.recheckCells(project.id, cells, matrixId));
}

function VerdictCompare({ a, b }: { a: Verdict & { run: unknown }; b: Verdict & { run: unknown } }) {
  const cfg = (v: Verdict & { run: unknown }) => {
    const snap = (v.run as { configSnapshot?: { model?: { value: string }; effort?: { value: string } } } | null)?.configSnapshot;
    return snap ? `${snap.model?.value ?? '—'} / ${snap.effort?.value ?? '—'}` : '—';
  };
  const rows: [string, (v: Verdict & { run: unknown }) => string][] = [
    [tr('Status'), (v) => CELL_STATUS[v.status]],
    [tr('Author'), (v) => v.author],
    [tr('Time'), (v) => time(v.createdAt)],
    [tr('Commit'), (v) => v.commitSha.slice(0, 8)],
    [tr('Model'), cfg],
    [tr('Rationale'), (v) => v.reason],
    [tr('Evidence'), (v) => v.evidence.map((e) => `${e.file}${e.line ? `:${e.line}` : ''}`).join('\n') || '—'],
  ];
  return (
    <table className="grid compact compare">
      <tbody>
        {rows.map(([label, f]) => (
          <tr key={label} className={f(a) !== f(b) ? 'diff' : ''}>
            <td className="muted">{label}</td>
            <td>{f(a)}</td>
            <td>{f(b)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CellDetailsView({ project, id, matrixId, revision, run, onSelect, onTerminal }: Common & { id: string; matrixId?: string }) {
  const [d, setD] = useState<CellDetails | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [form, setForm] = useState<'verdict' | 'finding' | null>(null);
  const [status, setStatus] = useState<VerdictStatus>('pass');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [fTitle, setFTitle] = useState('');
  const [fSeverity, setFSeverity] = useState<Severity>('medium');
  const [fCwe, setFCwe] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [link, setLink] = useState('');
  const [compare, setCompare] = useState<string[]>([]);

  useEffect(() => {
    setForm(null);
    setCompare([]);
  }, [id]);

  useEffect(() => {
    void run(api.cellDetails(project.id, id, matrixId)).then((x) => setD(x ?? null));
    void api.listFindings(project.id).then(setFindings);
  }, [project.id, id, matrixId, revision, run]);

  if (!d) return null;
  const v = d.cell.verdict;
  const saveVerdict = async () => {
    if (await run(api.setVerdict(project.id, id, { status, reason, evidence: parseEvidence(evidence) }))) setForm(null);
  };
  const saveFinding = async () => {
    const f = await run(
      api.createFinding(project.id, id, {
        title: fTitle,
        description: fDesc,
        severity: fSeverity,
        cwe: fCwe.trim() || null,
        entryPoint: null,
        files: parseEvidence(evidence),
        recommendation: null,
      }),
    );
    if (f) setForm(null);
  };
  const timeline = [
    ...d.verdicts.map((x) => ({ at: x.createdAt, key: x.id, verdict: x })),
    ...d.triage.map((t) => ({ at: t.createdAt, key: t.id, text: `${tr('triage')}: ${t.applicable ? tr('applicable') : 'n/a'} — ${t.reason}`, runId: t.runId, author: 'ai' })),
    ...d.findingEvents.map((e) => ({
      at: e.createdAt,
      key: e.id,
      text: `${tr('finding')} ${d.findings.find((f) => f.id === e.findingId)?.title ?? ''}: ${e.kind === 'created' ? tr('created') : e.kind === 'link' ? tr('linked to the cell') : e.kind === 'merged' ? tr('merged') : FINDING_STATUS[e.status!]}${e.reason ? ` — ${e.reason}` : ''}`,
      runId: e.runId,
      author: e.author,
    })),
  ].sort((x, y) => y.at.localeCompare(x.at));
  const toggleCompare = (vid: string) => setCompare((c) => (c.includes(vid) ? c.filter((x) => x !== vid) : [...c.slice(-1), vid]));
  const cmp = compare.map((c) => d.verdicts.find((x) => x.id === c)!).filter(Boolean);

  return (
    <section>
      <h3>
        {d.requirement ? (
          <>
            <span className="mono">{d.requirement.key}</span> × {d.module?.name ?? tr('module deleted')}
          </>
        ) : (
          tr('The requirement was removed from the document')
        )}
      </h3>
      {d.requirement && (
        <p>
          {d.requirement.text}
          <br />
          <span className="muted small">
            {d.requirement.documentTitle} · {d.requirement.section}
          </span>
        </p>
      )}
      <dl>
        <dt>{tr('Status')}</dt>
        <dd>
          <span className={`status cs-${d.cell.status.replace('/', '')}`}>{CELL_STATUS[d.cell.status]}</span>
          {d.cell.triaged && <span className="muted"> · {tr('triage')}: {tr('applicable')}</span>}
          {d.cell.stale && <span className="status stale"> {tr('stale')}: {d.cell.staleReasons.map((r) => STALE_REASON[r]).join(', ')}</span>}
        </dd>
        {d.changedFiles.length > 0 && (
          <>
            <dt>{tr('Changed|code')}</dt>
            <dd className="mono small">
              {d.changedFiles.slice(0, 10).map((f) => (
                <div key={f}>{f}</div>
              ))}
              {d.changedFiles.length > 10 && <div className="muted">{tr('…{n} more', { n: d.changedFiles.length - 10 })}</div>}
            </dd>
          </>
        )}
        {v && (
          <>
            <dt>{tr('Rationale')}</dt>
            <dd className="prewrap">{v.reason}</dd>
            <dt>{tr('Evidence')}</dt>
            <dd>
              <EvidenceList project={project} run={run} items={v.evidence} />
            </dd>
            <dt>{tr('Verdict')}</dt>
            <dd>
              {v.author} · {time(v.createdAt)} · <span className="mono">{v.commitSha.slice(0, 8)}</span>
              {v.runId && (
                <>
                  {' '}
                  · <a onClick={() => onSelect({ kind: 'run', id: v.runId! })}>{tr('run')}</a>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="actions">
        <IconButton
          icon="recheck"
          className="primary"
          title={tr('Recheck the cell')}
          label={tr('Recheck')}
          disabled={!d.module || !d.requirement || Boolean(d.cell.activeJob)}
          onClick={() => void confirmRecheck(project, run, [id], matrixId)}
        />
        {v?.runId && <IconButton icon="terminal" title={tr('Open the verdict session')} onClick={() => void run(api.openRun(project.id, v.runId!)).then(onTerminal)} />}
        <IconButton icon="verdict" title={tr('Set the verdict manually')} label={tr('Verdict')} aria-pressed={form === 'verdict'} onClick={() => setForm(form === 'verdict' ? null : 'verdict')} />
        <IconButton icon="finding" title={tr('Add a finding manually')} label={tr('Finding')} aria-pressed={form === 'finding'} onClick={() => setForm(form === 'finding' ? null : 'finding')} />
      </div>
      {form && (
        <div className="form module-form">
          {form === 'verdict' ? (
            <label>
              {tr('Status')}
              <select value={status} onChange={(e) => setStatus(e.target.value as VerdictStatus)}>
                {VERDICT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {CELL_STATUS[s]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                {tr('Heading')}
                <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} />
              </label>
              <label>
                Severity / CWE
                <span className="row">
                  <select value={fSeverity} onChange={(e) => setFSeverity(e.target.value as Severity)}>
                    {SEVERITIES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <input placeholder="CWE-639" value={fCwe} onChange={(e) => setFCwe(e.target.value)} />
                </span>
              </label>
            </>
          )}
          <label>
            {form === 'verdict' ? tr('Rationale') : tr('Description')}
            <textarea rows={3} value={form === 'verdict' ? reason : fDesc} onChange={(e) => (form === 'verdict' ? setReason(e.target.value) : setFDesc(e.target.value))} />
          </label>
          <label>
            {tr('Code (one per line: path[:line] [note], from the repository root)')}
            <textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" onClick={() => void (form === 'verdict' ? saveVerdict() : saveFinding())}>
              {tr('Save')}
            </button>
            <button onClick={() => setForm(null)}>{tr('Cancel')}</button>
          </div>
        </div>
      )}

      <Section title={tr('Findings')}>
      {d.findings.length === 0 && <div className="muted">{tr('none')}</div>}
      {d.findings.map((f) => (
        <div key={f.id} className="result">
          <a onClick={() => onSelect({ kind: 'finding', id: f.id })}>{f.title}</a>{' '}
          <span className={`status sev-${f.severity}`}>{SEVERITY[f.severity]}</span> <span className="muted">{FINDING_STATUS[f.status]}</span>
        </div>
      ))}
      <div className="actions">
        <select value={link} onChange={(e) => setLink(e.target.value)}>
          <option value="">{tr('link to a finding…')}</option>
          {findings
            .filter((f) => !f.mergedInto && !d.findings.some((x) => x.id === f.id))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
        </select>
        <IconButton icon="link" title={tr('Link the finding to the cell')} disabled={!link} onClick={() => void run(api.linkFinding(project.id, link, id)).then(() => setLink(''))} />
      </div>
      </Section>

      <Section title={tr('History')}>
      {cmp.length === 2 && <VerdictCompare a={cmp[0]} b={cmp[1]} />}
      {timeline.map((t) =>
        'verdict' in t && t.verdict ? (
          <div key={t.key} className="result">
            <div className="muted small">
              <input type="checkbox" title={tr('compare')} checked={compare.includes(t.verdict.id)} onChange={() => toggleCompare(t.verdict!.id)} /> {time(t.at)} ·{' '}
              {t.verdict.author} · <span className="mono">{t.verdict.commitSha.slice(0, 8)}</span>
              {t.verdict.run && (
                <>
                  {' '}
                  · <a onClick={() => void run(api.openRun(project.id, t.verdict!.runId!)).then(onTerminal)}>{tr('session')}</a>
                </>
              )}
            </div>
            <div>
              <span className={`status cs-${t.verdict.status.replace('/', '')}`}>{CELL_STATUS[t.verdict.status]}</span> {t.verdict.reason}
            </div>
          </div>
        ) : (
          <div key={t.key} className="result">
            <div className="muted small">
              {time(t.at)} · {'author' in t ? t.author : ''}
              {'runId' in t && t.runId && (
                <>
                  {' '}
                  · <a onClick={() => onSelect({ kind: 'run', id: t.runId! })}>{tr('run')}</a>
                </>
              )}
            </div>
            <div>{'text' in t ? t.text : ''}</div>
          </div>
        ),
      )}
      {timeline.length > 0 && <div className="muted small">{tr('Tick two verdicts to compare them.')}</div>}
      </Section>
      {d.config && <ConfigView config={d.config} title={tr('Effective configuration of the check')} />}
    </section>
  );
}

export function FindingDetailsView({ project, id, revision, run, onSelect, onTerminal }: Common & { id: string }) {
  const [d, setD] = useState<FindingDetails | null>(null);
  const [status, setStatus] = useState<FindingStatus>('verified');
  const [reason, setReason] = useState('');

  useEffect(() => {
    setReason('');
    void run(api.findingDetails(project.id, id)).then((x) => setD(x ?? null));
  }, [project.id, id, revision, run]);

  if (!d) return null;
  const f = d.finding;
  const merge = async (src: string, dst: string, title: string) => {
    if (!confirm(tr('Merge the finding “{title}”? Its cells move to the target finding, and it becomes a link.', { title }))) return;
    const r = await run(api.mergeFinding(project.id, src, dst));
    if (r) onSelect({ kind: 'finding', id: dst });
  };

  return (
    <section>
      <h3>{f.title}</h3>
      {f.mergedInto && (
        <div className="warn">
          {tr('Merged into')} <a onClick={() => onSelect({ kind: 'finding', id: f.mergedInto! })}>{tr('another finding')}</a>
        </div>
      )}
      <dl>
        <dt>{tr('Status')}</dt>
        <dd>
          <span className={`status fs-${f.status}`}>{FINDING_STATUS[f.status]}</span>
        </dd>
        <dt>Severity</dt>
        <dd>
          <span className={`status sev-${f.severity}`}>{SEVERITY[f.severity]}</span> {f.cwe && <span className="mono">{f.cwe}</span>}
        </dd>
        {f.entryPoint && (
          <>
            <dt>{tr('Entry point')}</dt>
            <dd className="mono small">{f.entryPoint}</dd>
          </>
        )}
        <dt>{tr('Description')}</dt>
        <dd className="prewrap">{f.description}</dd>
        {f.recommendation && (
          <>
            <dt>{tr('Recommendation')}</dt>
            <dd className="prewrap">{f.recommendation}</dd>
          </>
        )}
        <dt>{tr('Code')}</dt>
        <dd>
          <EvidenceList project={project} run={run} items={f.files} />
        </dd>
        <dt>{tr('Created')}</dt>
        <dd>
          {f.author} · {time(f.createdAt)}
          {f.runId && (
            <>
              {' '}
              · <a onClick={() => onSelect({ kind: 'run', id: f.runId! })}>{tr('run')}</a>
            </>
          )}
        </dd>
      </dl>
      {!f.mergedInto && (
        <>
          <div className="actions">
            <IconButton icon="fix" className="primary" title={tr('Open an interactive fix session')} label={tr('Fix')} onClick={() => void run(api.openFixSession(project.id, f.id)).then(onTerminal)} />
            <IconButton
              icon="recheck"
              title={tr('Recheck the linked matrix cells')}
              label={`${tr('Cells')} ${f.cells.length}`}
              disabled={!f.cells.length}
              onClick={() => void confirmRecheck(project, run, f.cells.map((c) => `${c.moduleId}/${c.requirementId}`))}
            />
          </div>
          <div className="actions">
            <select value={status} onChange={(e) => setStatus(e.target.value as FindingStatus)}>
              {FINDING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {FINDING_STATUS[s]}
                </option>
              ))}
            </select>
            <input placeholder={tr('reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
            <IconButton icon="check" title={tr('Change the status')} disabled={status === f.status} onClick={() => void run(api.setFindingStatus(project.id, f.id, status, reason))} />
          </div>
        </>
      )}

      <Section title={tr('PoC tester')}>
      {!f.mergedInto && (
        <div className="actions">
          <IconButton
            icon="poc"
            label="PoC"
            disabled={!d.poc.available || f.status !== 'suspected' || Boolean(d.poc.job)}
            title={!d.poc.available ? (d.poc.reason ?? tr('PoC unavailable')) : f.status !== 'suspected' ? tr('only for findings in the “suspected” status') : tr('Run the PoC tester')}
            onClick={() => void run(api.enqueuePoc(project.id, f.id))}
          />
          {d.poc.job && <span className="muted small">{tr('job queued: {status}', { status: d.poc.job.status })}</span>}
          {d.poc.baseUrl && <span className="muted small mono">{d.poc.baseUrl}</span>}
        </div>
      )}
      {!d.poc.available && <div className="muted small">{d.poc.reason}</div>}
      {d.poc.results.map((r) => (
        <div key={r.id} className="result">
          <div className="muted small">
            {time(r.createdAt)} · {r.author} · {r.commitSha.slice(0, 8)}
            {r.runId && (
              <>
                {' '}
                · <a onClick={() => onSelect({ kind: 'run', id: r.runId! })}>{tr('run')}</a>
              </>
            )}
          </div>
          <div>
            <span className={`status poc-${r.outcome}`}>{POC_OUTCOME[r.outcome]}</span> {r.summary}
          </div>
          {r.steps.map((st, i) => (
            <details key={i}>
              <summary className="mono small">{st.action}</summary>
              <pre className="small prewrap">{st.result}</pre>
              {st.note && <div className="muted small">{st.note}</div>}
            </details>
          ))}
        </div>
      ))}
      {d.poc.results[0]?.outcome === 'reproduced' && f.status === 'suspected' && (
        <div className="muted small">{tr('The PoC reproduced the finding: a human sets the “verified” status (above).')}</div>
      )}
      </Section>

      <Section title={tr('Matrix cells')}>
      {d.cells.length === 0 && <div className="muted">{tr('none')}</div>}
      {d.cells.map((c) => (
        <div key={`${c.moduleId}/${c.requirementId}`} className="result">
          <a onClick={() => onSelect({ kind: 'cell', id: `${c.moduleId}/${c.requirementId}` })}>
            <span className="mono">{c.key ?? c.requirementId}</span> × {c.moduleName ?? c.moduleId}
          </a>
          <div className="muted small">{c.text}</div>
        </div>
      ))}
      </Section>

      {d.scaItems.length > 0 && (
        <Section title={tr('Vulnerable dependencies (SCA)')}>
          {d.scaItems.map((x) => (
            <div key={`${x.moduleId}/${x.packageKey}#${x.vulnId}`} className="result">
              <a onClick={() => onSelect({ kind: 'sca', id: `${x.moduleId}/${x.packageKey}#${x.vulnId}` })}>
                <span className="mono">{x.vulnId}</span> {tr('in')} {x.packageKey}
              </a>
              <div className="muted small">{tr('module {name}', { name: x.moduleName ?? x.moduleId })}</div>
            </div>
          ))}
        </Section>
      )}

      {!f.mergedInto && d.similar.length > 0 && (
        <Section title={tr('Similar (manual merge)')}>
          {d.similar.map((s) => (
            <div key={s.finding.id} className="result">
              <a onClick={() => onSelect({ kind: 'finding', id: s.finding.id })}>{s.finding.title}</a>{' '}
              <span className="muted small">{FINDING_STATUS[s.finding.status]}</span>
              <div className="muted small">{s.reasons.join('; ')}</div>
              <div className="actions">
                <IconButton icon="merge" title={tr('Merge this finding into the current one')} label={tr('Into current')} onClick={() => void merge(s.finding.id, f.id, s.finding.title)} />
                <IconButton icon="merge" title={tr('Merge the current finding into this one')} label={tr('Current into it')} onClick={() => void merge(f.id, s.finding.id, f.title)} />
              </div>
            </div>
          ))}
        </Section>
      )}

      <Section title={tr('History')}>
      {[...d.events].reverse().map((e) => (
        <div key={e.id} className="result">
          <div className="muted small">
            {time(e.createdAt)} · {e.author}
            {e.runId && (
              <>
                {' '}
                · <a onClick={() => onSelect({ kind: 'run', id: e.runId! })}>{tr('run')}</a>
              </>
            )}
          </div>
          <div>
            {e.kind === 'created'
              ? tr('created')
              : e.kind === 'link'
                ? e.scaItem
                  ? tr('linked to vulnerability {vuln} in {package}', { vuln: e.scaItem.vulnId, package: e.scaItem.packageKey })
                  : tr('linked to cell {key}', { key: d.cells.find((c) => c.moduleId === e.cell?.moduleId && c.requirementId === e.cell?.requirementId)?.key ?? '' })
                : e.kind === 'merged'
                  ? tr('merged into another finding')
                  : tr('status: {status}', { status: FINDING_STATUS[e.status!] })}
            {e.reason && <span className="muted"> — {e.reason}</span>}
          </div>
        </div>
      ))}
      </Section>
      <Section title={tr('Sessions')}>
      {d.runs.length === 0 && <div className="muted">{tr('none')}</div>}
      {d.runs.map((r) => (
        <div key={r.id} className="result">
          <a onClick={() => onSelect({ kind: 'run', id: r.id })}>
            {r.role} · {r.kind === 'interactive' ? tr('interactive') : tr('background')} · {time(r.startedAt)}
          </a>
        </div>
      ))}
      </Section>
    </section>
  );
}
