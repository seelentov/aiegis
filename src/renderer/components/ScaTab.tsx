import { useEffect, useState } from 'react';
import type { ProjectInfo, ScaItem, ScaModuleView, ScaScope, ScaView, Severity } from '../../shared/types';
import { SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { INVENTORY_STATUS, JOB_STATUS, kTokens, SCA_STATUS, SEVERITY, time } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { IconButton } from './Icon';

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
        <IconButton
          icon={inv ? 'recheck' : 'package'}
          title={inv ? 'Повторить инвентаризацию модуля' : 'Инвентаризация модуля'}
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
        <IconButton icon="upload" title="Загрузить lock-файл, SBOM или отчёт" label="Загрузить" onClick={() => void upload()} />
        <label className="check">
          <input type="checkbox" checked={removed} onChange={(e) => setRemoved(e.target.checked)} /> показывать исключённые
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
                  {i.removedAt && <div>исключён: {i.removedBy}</div>}
                </td>
                <td className="actions">
                  {!i.removedAt && <IconButton icon="trash" title="Исключить файл" onClick={() => void run(api.removeScaInput(project.id, i.id))} />}
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
    { key: 'module', title: 'Модуль', text: (m) => m.module.name },
    { key: 'inventory', title: 'Инвентаризация', text: (m) => (m.inventory ? INVENTORY_STATUS[m.inventory.status] : 'нет'), filter: 'enum' },
    { key: 'summary', title: 'Инструменты и итог', text: (m) => (m.inventory?.summary ? `${m.inventory.summary.ecosystems.join(' ')} ${m.inventory.summary.tools.join(' ')}` : '') },
    { key: 'job', title: 'Задача', text: (m) => (m.inventoryJob ? JOB_STATUS[m.inventoryJob.status] : m.failedJob ? 'ошибка' : ''), filter: 'enum' },
    { key: 'actions', title: '', className: 'actions' },
  ]);
  const g = useGrid(
    'sca.items',
    all.filter((x) => (!stale || x.stale) && (!direct || x.direct)),
    [
      { key: 'package', title: 'Пакет', text: (x) => `${x.name}@${x.version} ${x.ecosystem}`, sort: (x) => x.name },
      { key: 'vuln', title: 'Уязвимость', text: (x) => `${x.vulnId} ${x.vuln.title ?? ''}`, sort: (x) => x.vulnId },
      { key: 'severity', title: 'Severity', text: (x) => SEVERITY[x.vuln.severity], sort: (x) => -SEV_RANK[x.vuln.severity], filter: 'enum' },
      { key: 'fixed', title: 'Исправлено в', text: (x) => x.vuln.fixedVersion ?? '—' },
      { key: 'status', title: 'Достижимость', text: (x) => SCA_STATUS[x.status], filter: 'enum' },
      { key: 'module', title: 'Модуль', text: (x) => moduleName(x.moduleId), filter: 'enum' },
    ],
  );
  // Without a chosen sort the worst vulnerabilities lead.
  const items = g.sorted ? g.rows : [...g.rows].sort((a, b) => SEV_RANK[b.vuln.severity] - SEV_RANK[a.vuln.severity] || a.name.localeCompare(b.name));

  if (!view) return null;
  if (!view.modules.length) return <div className="empty">Сначала разметьте модули: SCA строится по модулям.</div>;

  return (
    <div className="signals-tab sca-tab">
      <div className="toolbar">
        <select aria-label="Область запуска" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">все модули</option>
          {view.modules.map((m) => (
            <option key={m.module.id} value={m.module.id}>
              {m.module.name}
            </option>
          ))}
        </select>
        <span className="toolbar-group">
          <IconButton
            icon="package"
            title={`Инвентаризация зависимостей: ${moduleId ? 'выбранный модуль' : 'все модули'}`}
            label="Инвентаризация"
            onClick={() => void run(api.enqueueScaInventories(project.id, moduleIds))}
          />
          <IconButton
            icon="play"
            className="primary"
            title="Проверить достижимость непроверенных пунктов"
            label={`Достижимость ${count((x) => x.status === 'not_checked')}`}
            disabled={!count((x) => x.status === 'not_checked')}
            onClick={() => void confirmSca(project, run, { scope: 'pending', moduleIds }, notify)}
          />
          <IconButton
            icon="recheck"
            title="Перепроверить устаревшие пункты"
            label={`Устаревшие ${count((x) => x.stale)}`}
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
        <h3>Уязвимые зависимости</h3>
        <label className="check">
          <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} /> только прямые
        </label>
        <label className="check">
          <input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} /> только устаревшие
        </label>
        {g.count}
      </div>
      <table className="grid">
        {g.head}
        <tbody>
          {items.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered || stale || direct}>
              Уязвимых зависимостей нет или инвентаризация ещё не проводилась
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
