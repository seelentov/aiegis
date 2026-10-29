import { useEffect, useState } from 'react';
import type { Finding, ProjectInfo, ScaItemDetails, ScaVerdictStatus, Severity } from '../../shared/types';
import { SCA_STATUSES, SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { FINDING_STATUS, INVENTORY_STATUS, SCA_STATUS, SEVERITY, time } from '../format';
import { EvidenceList, parseEvidence } from './AuditDetails';
import { ConfigView } from './ConfigView';
import type { Selection } from './DetailsPanel';
import { confirmSca } from './ScaTab';

interface Common {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  onSelect: (s: Selection | null) => void;
  onTerminal: (id: string | undefined) => void;
}

export function ScaItemDetailsView({ project, id, revision, run, onSelect, onTerminal }: Common & { id: string }) {
  const [d, setD] = useState<ScaItemDetails | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [form, setForm] = useState<'verdict' | 'finding' | null>(null);
  const [status, setStatus] = useState<ScaVerdictStatus>('not_reachable');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [fTitle, setFTitle] = useState('');
  const [fSeverity, setFSeverity] = useState<Severity>('high');
  const [fDesc, setFDesc] = useState('');
  const [link, setLink] = useState('');

  useEffect(() => setForm(null), [id]);

  useEffect(() => {
    void run(api.scaItemDetails(project.id, id)).then((x) => setD(x ?? null));
    void api.listFindings(project.id).then(setFindings);
  }, [project.id, id, revision, run]);

  if (!d) return null;
  const { item, package: pkg, inventory: inv } = d;
  const v = item.verdict;
  const openForm = (f: 'verdict' | 'finding') => {
    if (f === 'finding' && !fTitle) {
      setFTitle(`${pkg.name}@${pkg.version}: ${item.vulnId}`);
      setFSeverity(item.vuln.severity === 'info' ? 'medium' : item.vuln.severity);
    }
    setForm(form === f ? null : f);
  };
  const saveVerdict = async () => {
    if (await run(api.setScaVerdict(project.id, id, { status, reason, evidence: parseEvidence(evidence) }))) setForm(null);
  };
  const saveFinding = async () => {
    const f = await run(
      api.createScaFinding(project.id, id, {
        title: fTitle,
        description: fDesc,
        severity: fSeverity,
        cwe: null,
        entryPoint: null,
        files: parseEvidence(evidence),
        recommendation: item.vuln.fixedVersion ? `Обновить ${pkg.name} до ${item.vuln.fixedVersion} или новее.` : null,
      }),
    );
    if (f) setForm(null);
  };
  const timeline = [
    ...d.verdicts.map((x) => ({
      at: x.createdAt,
      key: x.id,
      head: `${x.author} · ${x.commitSha.slice(0, 8)}`,
      runId: x.runId,
      session: Boolean(x.run),
      body: (
        <>
          <span className={`status ss-${x.status}`}>{SCA_STATUS[x.status]}</span> {x.reason}
        </>
      ),
    })),
    ...d.findingEvents.map((e) => ({
      at: e.createdAt,
      key: e.id,
      head: e.author,
      runId: e.runId,
      session: false,
      body: (
        <>
          находка {d.findings.find((f) => f.id === e.findingId)?.title ?? ''}:{' '}
          {e.kind === 'created' ? 'создана' : e.kind === 'link' ? 'связана с уязвимостью' : e.kind === 'merged' ? 'объединена' : FINDING_STATUS[e.status!]}
          {e.reason ? ` — ${e.reason}` : ''}
        </>
      ),
    })),
  ].sort((x, y) => y.at.localeCompare(x.at));

  return (
    <section>
      <h3>
        <span className="mono">{item.vulnId}</span> в {pkg.name}@{pkg.version}
      </h3>
      {item.vuln.title && <p>{item.vuln.title}</p>}
      <dl>
        <dt>Модуль</dt>
        <dd>{d.module?.name ?? 'удалён'}</dd>
        <dt>Severity</dt>
        <dd>
          <span className={`status sev-${item.vuln.severity}`}>{SEVERITY[item.vuln.severity]}</span>
          {item.vuln.aliases.length > 0 && <span className="mono small"> {item.vuln.aliases.join(', ')}</span>}
        </dd>
        <dt>Исправлено в</dt>
        <dd className="mono">{item.vuln.fixedVersion ?? '—'}</dd>
        <dt>Пакет</dt>
        <dd>
          {pkg.ecosystem} · {pkg.direct === null ? 'прямая?' : pkg.direct ? 'прямая зависимость' : 'транзитивная'}
          {pkg.manifest && (
            <div>
              <a className="mono small" onClick={() => void run(api.openInEditor(pkg.manifest!, undefined, project.id))}>
                {pkg.manifest}
              </a>
            </div>
          )}
          {pkg.purl && <div className="mono small muted">{pkg.purl}</div>}
        </dd>
        <dt>Имена импорта</dt>
        <dd className="mono small">{pkg.importNames.join(', ') || <span className="muted">неизвестны — префильтр не применяется</span>}</dd>
        <dt>Ссылки в модуле</dt>
        <dd className="mono small">
          {d.importHits === null ? (
            <span className="muted">—</span>
          ) : d.importHits.length === 0 ? (
            <span className="muted">нет (на HEAD)</span>
          ) : (
            <>
              {d.importHits.slice(0, 10).map((f) => (
                <div key={f}>
                  <a onClick={() => void run(api.openInEditor(f, undefined, project.id))}>{f}</a>
                </div>
              ))}
              {d.importHits.length > 10 && <div className="muted">…ещё {d.importHits.length - 10}</div>}
            </>
          )}
        </dd>
        <dt>Инвентаризация</dt>
        <dd>
          {INVENTORY_STATUS[inv.status]} · <span className="mono">{inv.commitSha.slice(0, 8)}</span> · {time(inv.finishedAt)} ·{' '}
          <a onClick={() => onSelect({ kind: 'run', id: inv.runId })}>прогон</a>
          {d.report && (
            <>
              {' '}
              ·{' '}
              <a onClick={() => void run(api.scaReportPath(project.id, d.report!.id)).then((f) => void (f && run(api.openInEditor(f))))}>
                отчёт {d.report.path.split('/').pop()}
              </a>
            </>
          )}
        </dd>
        <dt>Достижимость</dt>
        <dd>
          <span className={`status ss-${item.status}`}>{SCA_STATUS[item.status]}</span>
          {v?.author === 'auto' && <span className="muted"> · префильтр без ИИ</span>}
          {item.stale && <span className="status stale">устарело: изменился код</span>}
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
          </>
        )}
      </dl>
      <div className="actions">
        <button className="primary" disabled={Boolean(item.activeJob) || !d.module} onClick={() => void confirmSca(project, run, { items: [id] })}>
          Перепроверить
        </button>
        {v?.runId && <button onClick={() => void run(api.openRun(project.id, v.runId!)).then(onTerminal)}>Провалиться</button>}
        <button onClick={() => openForm('verdict')}>Вердикт вручную</button>
        <button onClick={() => openForm('finding')}>Находка вручную</button>
      </div>
      {form && (
        <div className="form module-form">
          {form === 'verdict' ? (
            <label>
              Статус
              <select value={status} onChange={(e) => setStatus(e.target.value as ScaVerdictStatus)}>
                {SCA_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {SCA_STATUS[s]}
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
                Severity
                <select value={fSeverity} onChange={(e) => setFSeverity(e.target.value as Severity)}>
                  {SEVERITIES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
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
          <a onClick={() => onSelect({ kind: 'finding', id: f.id })}>{f.title}</a> <span className={`status sev-${f.severity}`}>{SEVERITY[f.severity]}</span>{' '}
          <span className="muted">{FINDING_STATUS[f.status]}</span>
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
        <button disabled={!link} onClick={() => void run(api.linkScaFinding(project.id, link, id)).then(() => setLink(''))}>
          Связать
        </button>
      </div>

      <h4>История</h4>
      {timeline.length === 0 && <div className="muted">нет</div>}
      {timeline.map((t) => (
        <div key={t.key} className="result">
          <div className="muted small">
            {time(t.at)} · {t.head}
            {t.runId && (
              <>
                {' '}
                ·{' '}
                {t.session ? (
                  <a onClick={() => void run(api.openRun(project.id, t.runId!)).then(onTerminal)}>сессия</a>
                ) : (
                  <a onClick={() => onSelect({ kind: 'run', id: t.runId! })}>прогон</a>
                )}
              </>
            )}
          </div>
          <div>{t.body}</div>
        </div>
      ))}
      {d.config && <ConfigView config={d.config} title="Итоговая конфигурация проверки достижимости" />}
    </section>
  );
}
