import { useEffect, useState } from 'react';
import type { ProjectInfo, ScaItem, ScaItemStatus, ScaModuleView, ScaScope, ScaView, Severity } from '../../shared/types';
import { SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { INVENTORY_STATUS, JOB_STATUS, kTokens, SCA_STATUS, SEVERITY, time } from '../format';
import type { Selection } from './DetailsPanel';

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
    notify?.('warn', e.busy ? `Все выбранные пункты уже в очереди (${e.busy}).` : 'Нет SCA-пунктов для проверки.');
    return;
  }
  const over = e.tokensPerSession > e.maxTokensPerRun ? ` Оценка сессии выше лимита ${kTokens(e.maxTokensPerRun)}!` : '';
  const text =
    `Достижимость: пунктов ${e.items}; без ИИ закроет префильтр: ${e.auto}; сессий ИИ ${e.sessions} (по пакету), ` +
    `≈${kTokens(e.tokens)} токенов (${e.tokensPerSessionSource === 'history' ? 'по истории' : 'по конфигу'})` +
    `${e.busy ? `, уже в очереди: ${e.busy}` : ''}.${over} Запустить?`;
  if (!confirm(text)) return;
  const r = await run(api.runSca(project.id, o));
  if (r) notify?.('info', `Префильтр закрыл пунктов: ${r.auto}; в очереди сессий: ${r.jobs.length}.`);
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
            {m.inventoryStale && <span className="status stale">устарела</span>}
            <div className="muted small">
              {time(inv.finishedAt)} · <a onClick={() => onSelect({ kind: 'run', id: inv.runId })}>прогон</a>
            </div>
          </>
        ) : (
          <span className="muted">нет</span>
        )}
      </td>
      <td className="small">
        {inv?.summary ? (
          <>
            {inv.summary.ecosystems.join(', ')} · {inv.summary.tools.join(', ')}
            <div className="muted">
              зависимостей {inv.summary.dependenciesTotal}, уязвимых пакетов {inv.packageCount}, уязвимостей {inv.vulnCount}
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
            ошибка последней инвентаризации
          </a>
        )}
      </td>
      <td className="actions">
        <button disabled={Boolean(job)} onClick={() => void run(api.enqueueScaInventories(project.id, [m.module.id]))}>
          Инвентаризация
        </button>
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
  const moduleName = (id: string | null) => (id ? (view.modules.find((m) => m.module.id === id)?.module.name ?? id.slice(0, 8)) : 'весь проект');
  const shown = view.inputs.filter((i) => removed || !i.removedAt);
  return (
    <details className="sca-inputs">
      <summary>Загруженные файлы зависимостей ({view.inputs.filter((i) => !i.removedAt).length})</summary>
      <p className="muted small">
        Lock-файлы, SBOM, отчёты сканеров — передаются агенту инвентаризации следующего запуска (модуля или всего проекта).
      </p>
      <div className="toolbar">
        <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">весь проект</option>
          {view.modules.map((m) => (
            <option key={m.module.id} value={m.module.id}>
              {m.module.name}
            </option>
          ))}
        </select>
        <input placeholder="комментарий (что это за файл)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button onClick={() => void upload()}>Загрузить файл…</button>
        <label className="check">
          <input type="checkbox" checked={removed} onChange={(e) => setRemoved(e.target.checked)} /> показывать убранные
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
                  {i.removedAt && <div>убран: {i.removedBy}</div>}
                </td>
                <td className="actions">
                  {!i.removedAt && <button onClick={() => void run(api.removeScaInput(project.id, i.id))}>Убрать</button>}
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
  const [status, setStatus] = useState<ScaItemStatus | 'stale' | ''>('');
  const [minSev, setMinSev] = useState<Severity | ''>('');
  const [direct, setDirect] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    void run(api.scaView(project.id)).then((v) => v && setView(v));
  }, [project.id, revision, run]);

  if (!view) return null;
  if (!view.modules.length) return <div className="empty">Сначала разметьте модули: SCA строится по модулям.</div>;
  const mods = view.modules.filter((m) => !moduleId || m.module.id === moduleId);
  const moduleIds = moduleId ? [moduleId] : undefined;
  const items = mods
    .flatMap((m) => m.items)
    .filter(
      (x) =>
        (!status || (status === 'stale' ? x.stale : x.status === status)) &&
        (!minSev || SEV_RANK[x.vuln.severity] >= SEV_RANK[minSev]) &&
        (!direct || x.direct) &&
        (!text || `${x.name}@${x.version} ${x.vulnId}`.toLowerCase().includes(text.toLowerCase())),
    )
    .sort((a, b) => SEV_RANK[b.vuln.severity] - SEV_RANK[a.vuln.severity] || a.name.localeCompare(b.name) || a.vulnId.localeCompare(b.vulnId));
  const all = mods.flatMap((m) => m.items);
  const count = (f: (x: ScaItem) => boolean) => all.filter(f).length;
  const moduleName = (id: string) => view.modules.find((m) => m.module.id === id)?.module.name ?? id.slice(0, 8);

  return (
    <div className="signals-tab sca-tab">
      <div className="toolbar">
        <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">все модули</option>
          {view.modules.map((m) => (
            <option key={m.module.id} value={m.module.id}>
              {m.module.name}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => void run(api.enqueueScaInventories(project.id, moduleIds))}>
          Инвентаризация {moduleId ? 'модуля' : 'всех модулей'}
        </button>
        <button disabled={!count((x) => x.status === 'not_checked')} onClick={() => void confirmSca(project, run, { scope: 'pending', moduleIds }, notify)}>
          Проверить достижимость ({count((x) => x.status === 'not_checked')})
        </button>
        <button disabled={!count((x) => x.stale)} onClick={() => void confirmSca(project, run, { scope: 'stale', moduleIds }, notify)}>
          Перепроверить устаревшие ({count((x) => x.stale)})
        </button>
      </div>
      <table className="grid compact">
        <thead>
          <tr>
            <th>Модуль</th>
            <th>Инвентаризация</th>
            <th>Инструменты и итог</th>
            <th>Задача</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {mods.map((m) => (
            <InventoryRow key={m.module.id} m={m} project={project} run={run} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
      <Inputs project={project} run={run} view={view} />

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value as ScaItemStatus | 'stale' | '')}>
          <option value="">все статусы ({all.length})</option>
          {(Object.keys(SCA_STATUS) as ScaItemStatus[]).map((s) => (
            <option key={s} value={s}>
              {SCA_STATUS[s]} ({count((x) => x.status === s)})
            </option>
          ))}
          <option value="stale">устаревшие ({count((x) => x.stale)})</option>
        </select>
        <select value={minSev} onChange={(e) => setMinSev(e.target.value as Severity | '')}>
          <option value="">любая severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              ≥ {SEVERITY[s]}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} /> только прямые зависимости
        </label>
        <input placeholder="пакет или CVE…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Пакет</th>
            <th>Уязвимость</th>
            <th>Severity</th>
            <th>Исправлено в</th>
            <th>Достижимость</th>
            <th>Модуль</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {all.length ? 'Нет пунктов под фильтр' : 'Уязвимых зависимостей нет или инвентаризация ещё не проводилась'}
              </td>
            </tr>
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
                    {x.ecosystem} · {x.direct === null ? 'прямая?' : x.direct ? 'прямая' : 'транзитивная'}
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
                  {x.stale && <span className="status stale">устарело</span>}
                  {x.findingCount > 0 && <span className="muted small"> · находок {x.findingCount}</span>}
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
