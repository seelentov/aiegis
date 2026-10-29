import { useEffect, useState } from 'react';
import type { CellDetails, Evidence, Finding, FindingDetails, FindingStatus, ProjectInfo, Severity, Verdict, VerdictStatus } from '../../shared/types';
import { FINDING_STATUSES, SEVERITIES, VERDICT_STATUSES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { CELL_STATUS, FINDING_STATUS, kTokens, SEVERITY, STALE_REASON, time } from '../format';
import { ConfigView } from './ConfigView';
import type { Selection } from './DetailsPanel';

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
  const text = `Перепроверка: сессий ${e.sessions}, ячеек ${e.cells}, ≈${kTokens(e.tokens)} токенов (${e.tokensPerCellSource === 'history' ? 'по истории' : 'по конфигу'})${e.busy ? `, уже в очереди: ${e.busy}` : ''}. Запустить?`;
  if (e.cells && confirm(text)) await run(api.recheckCells(project.id, cells, matrixId));
}

function VerdictCompare({ a, b }: { a: Verdict & { run: unknown }; b: Verdict & { run: unknown } }) {
  const cfg = (v: Verdict & { run: unknown }) => {
    const snap = (v.run as { configSnapshot?: { model?: { value: string }; effort?: { value: string } } } | null)?.configSnapshot;
    return snap ? `${snap.model?.value ?? '—'} / ${snap.effort?.value ?? '—'}` : '—';
  };
  const rows: [string, (v: Verdict & { run: unknown }) => string][] = [
    ['Статус', (v) => CELL_STATUS[v.status]],
    ['Автор', (v) => v.author],
    ['Время', (v) => time(v.createdAt)],
    ['Коммит', (v) => v.commitSha.slice(0, 8)],
    ['Модель', cfg],
    ['Обоснование', (v) => v.reason],
    ['Доказательства', (v) => v.evidence.map((e) => `${e.file}${e.line ? `:${e.line}` : ''}`).join('\n') || '—'],
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
    ...d.triage.map((t) => ({ at: t.createdAt, key: t.id, text: `отсев: ${t.applicable ? 'применимо' : 'n/a'} — ${t.reason}`, runId: t.runId, author: 'ai' })),
    ...d.findingEvents.map((e) => ({
      at: e.createdAt,
      key: e.id,
      text: `находка ${d.findings.find((f) => f.id === e.findingId)?.title ?? ''}: ${e.kind === 'created' ? 'создана' : e.kind === 'link' ? 'связана с ячейкой' : e.kind === 'merged' ? 'объединена' : FINDING_STATUS[e.status!]}${e.reason ? ` — ${e.reason}` : ''}`,
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
            <span className="mono">{d.requirement.key}</span> × {d.module?.name ?? 'модуль удалён'}
          </>
        ) : (
          'Требование выведено из документа'
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
        <dt>Статус</dt>
        <dd>
          <span className={`status cs-${d.cell.status.replace('/', '')}`}>{CELL_STATUS[d.cell.status]}</span>
          {d.cell.triaged && <span className="muted"> · отсев: применимо</span>}
          {d.cell.stale && <span className="status stale"> устарело: {d.cell.staleReasons.map((r) => STALE_REASON[r]).join(', ')}</span>}
        </dd>
        {d.changedFiles.length > 0 && (
          <>
            <dt>Изменены</dt>
            <dd className="mono small">
              {d.changedFiles.slice(0, 10).map((f) => (
                <div key={f}>{f}</div>
              ))}
              {d.changedFiles.length > 10 && <div className="muted">…ещё {d.changedFiles.length - 10}</div>}
            </dd>
          </>
        )}
        {v && (
          <>
            <dt>Обоснование</dt>
            <dd className="prewrap">{v.reason}</dd>
            <dt>Доказательства</dt>
            <dd>
              <EvidenceList project={project} run={run} items={v.evidence} />
            </dd>
            <dt>Вердикт</dt>
            <dd>
              {v.author} · {time(v.createdAt)} · <span className="mono">{v.commitSha.slice(0, 8)}</span>
              {v.runId && (
                <>
                  {' '}
                  · <a onClick={() => onSelect({ kind: 'run', id: v.runId! })}>прогон</a>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="actions">
        <button className="primary" disabled={!d.module || !d.requirement || Boolean(d.cell.activeJob)} onClick={() => void confirmRecheck(project, run, [id], matrixId)}>
          Перепроверить
        </button>
        {v?.runId && <button onClick={() => void run(api.openRun(project.id, v.runId!)).then(onTerminal)}>Провалиться</button>}
        <button onClick={() => setForm(form === 'verdict' ? null : 'verdict')}>Вердикт вручную</button>
        <button onClick={() => setForm(form === 'finding' ? null : 'finding')}>Находка вручную</button>
      </div>
      {form && (
        <div className="form module-form">
          {form === 'verdict' ? (
            <label>
              Статус
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
                Заголовок
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
            {form === 'verdict' ? 'Обоснование' : 'Описание'}
            <textarea rows={3} value={form === 'verdict' ? reason : fDesc} onChange={(e) => (form === 'verdict' ? setReason(e.target.value) : setFDesc(e.target.value))} />
          </label>
          <label>
            Код (по строке: путь[:строка] [заметка], от корня репозитория)
            <textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" onClick={() => void (form === 'verdict' ? saveVerdict() : saveFinding())}>
              Сохранить
            </button>
            <button onClick={() => setForm(null)}>Отмена</button>
          </div>
        </div>
      )}

      <h4>Находки</h4>
      {d.findings.length === 0 && <div className="muted">нет</div>}
      {d.findings.map((f) => (
        <div key={f.id} className="result">
          <a onClick={() => onSelect({ kind: 'finding', id: f.id })}>{f.title}</a>{' '}
          <span className={`status sev-${f.severity}`}>{SEVERITY[f.severity]}</span> <span className="muted">{FINDING_STATUS[f.status]}</span>
        </div>
      ))}
      <div className="actions">
        <select value={link} onChange={(e) => setLink(e.target.value)}>
          <option value="">связать с находкой…</option>
          {findings
            .filter((f) => !f.mergedInto && !d.findings.some((x) => x.id === f.id))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
        </select>
        <button disabled={!link} onClick={() => void run(api.linkFinding(project.id, link, id)).then(() => setLink(''))}>
          Связать
        </button>
      </div>

      <h4>История</h4>
      {cmp.length === 2 && <VerdictCompare a={cmp[0]} b={cmp[1]} />}
      {timeline.map((t) =>
        'verdict' in t && t.verdict ? (
          <div key={t.key} className="result">
            <div className="muted small">
              <input type="checkbox" title="сравнить" checked={compare.includes(t.verdict.id)} onChange={() => toggleCompare(t.verdict!.id)} /> {time(t.at)} ·{' '}
              {t.verdict.author} · <span className="mono">{t.verdict.commitSha.slice(0, 8)}</span>
              {t.verdict.run && (
                <>
                  {' '}
                  · <a onClick={() => void run(api.openRun(project.id, t.verdict!.runId!)).then(onTerminal)}>сессия</a>
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
                  · <a onClick={() => onSelect({ kind: 'run', id: t.runId! })}>прогон</a>
                </>
              )}
            </div>
            <div>{'text' in t ? t.text : ''}</div>
          </div>
        ),
      )}
      {timeline.length > 0 && <div className="muted small">Отметьте два вердикта, чтобы сравнить их.</div>}
      {d.config && <ConfigView config={d.config} title="Итоговая конфигурация проверки" />}
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
    if (!confirm(`Объединить находку «${title}»? Её ячейки перейдут в целевую находку, сама она станет ссылкой.`)) return;
    const r = await run(api.mergeFinding(project.id, src, dst));
    if (r) onSelect({ kind: 'finding', id: dst });
  };

  return (
    <section>
      <h3>{f.title}</h3>
      {f.mergedInto && (
        <div className="warn">
          Объединена с <a onClick={() => onSelect({ kind: 'finding', id: f.mergedInto! })}>другой находкой</a>
        </div>
      )}
      <dl>
        <dt>Статус</dt>
        <dd>
          <span className={`status fs-${f.status}`}>{FINDING_STATUS[f.status]}</span>
        </dd>
        <dt>Severity</dt>
        <dd>
          <span className={`status sev-${f.severity}`}>{SEVERITY[f.severity]}</span> {f.cwe && <span className="mono">{f.cwe}</span>}
        </dd>
        {f.entryPoint && (
          <>
            <dt>Точка входа</dt>
            <dd className="mono small">{f.entryPoint}</dd>
          </>
        )}
        <dt>Описание</dt>
        <dd className="prewrap">{f.description}</dd>
        {f.recommendation && (
          <>
            <dt>Рекомендация</dt>
            <dd className="prewrap">{f.recommendation}</dd>
          </>
        )}
        <dt>Код</dt>
        <dd>
          <EvidenceList project={project} run={run} items={f.files} />
        </dd>
        <dt>Создана</dt>
        <dd>
          {f.author} · {time(f.createdAt)}
          {f.runId && (
            <>
              {' '}
              · <a onClick={() => onSelect({ kind: 'run', id: f.runId! })}>прогон</a>
            </>
          )}
        </dd>
      </dl>
      {!f.mergedInto && (
        <>
          <div className="actions">
            <button className="primary" onClick={() => void run(api.openFixSession(project.id, f.id)).then(onTerminal)}>
              Открыть сессию для фикса
            </button>
            <button disabled={!f.cells.length} onClick={() => void confirmRecheck(project, run, f.cells.map((c) => `${c.moduleId}/${c.requirementId}`))}>
              Перепроверить ячейки
            </button>
          </div>
          <div className="actions">
            <select value={status} onChange={(e) => setStatus(e.target.value as FindingStatus)}>
              {FINDING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {FINDING_STATUS[s]}
                </option>
              ))}
            </select>
            <input placeholder="причина" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button disabled={status === f.status} onClick={() => void run(api.setFindingStatus(project.id, f.id, status, reason))}>
              Сменить статус
            </button>
          </div>
        </>
      )}

      <h4>Ячейки матрицы</h4>
      {d.cells.length === 0 && <div className="muted">нет</div>}
      {d.cells.map((c) => (
        <div key={`${c.moduleId}/${c.requirementId}`} className="result">
          <a onClick={() => onSelect({ kind: 'cell', id: `${c.moduleId}/${c.requirementId}` })}>
            <span className="mono">{c.key ?? c.requirementId}</span> × {c.moduleName ?? c.moduleId}
          </a>
          <div className="muted small">{c.text}</div>
        </div>
      ))}

      {d.scaItems.length > 0 && (
        <>
          <h4>Уязвимые зависимости (SCA)</h4>
          {d.scaItems.map((x) => (
            <div key={`${x.moduleId}/${x.packageKey}#${x.vulnId}`} className="result">
              <a onClick={() => onSelect({ kind: 'sca', id: `${x.moduleId}/${x.packageKey}#${x.vulnId}` })}>
                <span className="mono">{x.vulnId}</span> в {x.packageKey}
              </a>
              <div className="muted small">модуль {x.moduleName ?? x.moduleId}</div>
            </div>
          ))}
        </>
      )}

      {!f.mergedInto && d.similar.length > 0 && (
        <>
          <h4>Похожие (ручное слияние)</h4>
          {d.similar.map((s) => (
            <div key={s.finding.id} className="result">
              <a onClick={() => onSelect({ kind: 'finding', id: s.finding.id })}>{s.finding.title}</a>{' '}
              <span className="muted small">{FINDING_STATUS[s.finding.status]}</span>
              <div className="muted small">{s.reasons.join('; ')}</div>
              <div className="actions">
                <button onClick={() => void merge(s.finding.id, f.id, s.finding.title)}>Влить её в эту</button>
                <button onClick={() => void merge(f.id, s.finding.id, f.title)}>Влить эту в неё</button>
              </div>
            </div>
          ))}
        </>
      )}

      <h4>История</h4>
      {[...d.events].reverse().map((e) => (
        <div key={e.id} className="result">
          <div className="muted small">
            {time(e.createdAt)} · {e.author}
            {e.runId && (
              <>
                {' '}
                · <a onClick={() => onSelect({ kind: 'run', id: e.runId! })}>прогон</a>
              </>
            )}
          </div>
          <div>
            {e.kind === 'created'
              ? 'создана'
              : e.kind === 'link'
                ? e.scaItem
                  ? `связана с уязвимостью ${e.scaItem.vulnId} в ${e.scaItem.packageKey}`
                  : `связана с ячейкой ${d.cells.find((c) => c.moduleId === e.cell?.moduleId && c.requirementId === e.cell?.requirementId)?.key ?? ''}`
                : e.kind === 'merged'
                  ? 'объединена с другой находкой'
                  : `статус: ${FINDING_STATUS[e.status!]}`}
            {e.reason && <span className="muted"> — {e.reason}</span>}
          </div>
        </div>
      ))}
      <h4>Сессии</h4>
      {d.runs.length === 0 && <div className="muted">нет</div>}
      {d.runs.map((r) => (
        <div key={r.id} className="result">
          <a onClick={() => onSelect({ kind: 'run', id: r.id })}>
            {r.role} · {r.kind === 'interactive' ? 'интерактивная' : 'фоновая'} · {time(r.startedAt)}
          </a>
        </div>
      ))}
    </section>
  );
}
