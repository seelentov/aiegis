import { Fragment, useEffect, useState } from 'react';
import type { Cell, DocumentSummary, Matrix, MatrixEstimate, MatrixScope, MatrixStage, MatrixView, ModuleSummary, ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { CELL_STATUS, JOB_STATUS, kTokens, STALE_REASON } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid, type Col } from './Grid';
import { Icon, IconButton } from './Icon';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}

function MatrixForm({ project, run, matrix, onDone }: { project: ProjectInfo; run: RunFn; matrix?: Matrix; onDone: (m?: Matrix) => void }) {
  const [name, setName] = useState(matrix?.name ?? '');
  const [docs, setDocs] = useState<string[]>(matrix?.documentIds ?? []);
  const [mods, setMods] = useState<string[]>(matrix?.moduleIds ?? []);
  const [allDocs, setAllDocs] = useState<DocumentSummary[]>([]);
  const [allMods, setAllMods] = useState<ModuleSummary[]>([]);
  useEffect(() => {
    void api.listDocuments(project.id).then(setAllDocs);
    void api.listModules(project.id).then(setAllMods);
  }, [project.id]);
  const toggle = (list: string[], set: (x: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const save = async () => {
    const m = await run(api.saveMatrix(project.id, { id: matrix?.id, name, documentIds: docs, moduleIds: mods }));
    if (m) onDone(m);
  };
  return (
    <div className="form">
      <label>
        Название
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div />
      <fieldset>
        <legend>Документы (утверждённые версии)</legend>
        {allDocs.map((d) => (
          <label key={d.id} className="check">
            <input type="checkbox" checked={docs.includes(d.id)} disabled={!d.current} onChange={() => toggle(docs, setDocs, d.id)} />
            {d.title} {d.current ? <span className="muted">v{d.current.n}</span> : <span className="muted">(нет утверждённой версии)</span>}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Модули (ничего не выбрано — все)</legend>
        {allMods.map((m) => (
          <label key={m.id} className="check">
            <input type="checkbox" checked={mods.includes(m.id)} onChange={() => toggle(mods, setMods, m.id)} />
            {m.name}
          </label>
        ))}
      </fieldset>
      <div className="wide row">
        <button className="primary" disabled={!name.trim() || !docs.length} onClick={() => void save()}>
          Сохранить
        </button>
        <button onClick={() => onDone()}>Отмена</button>
      </div>
    </div>
  );
}

const STAGE_TITLE: Record<MatrixStage, string> = { triage: 'Отсев n/a', verdicts: 'Вердикты' };

/** Dry-run estimate shown before queuing a matrix stage (SPEC §7). */
export function EstimatePanel({ estimate, title, onRun, onCancel }: { estimate: MatrixEstimate; title?: string; onRun: () => void; onCancel: () => void }) {
  const over = estimate.batches.filter((b) => b.tokens > estimate.maxTokensPerRun);
  return (
    <div className="card estimate">
      <strong>
        Оценка: {title ?? STAGE_TITLE[estimate.stage]} (роль {estimate.role})
      </strong>
      <div>
        Сессий: {estimate.sessions} · ячеек: {estimate.cells} · ≈{kTokens(estimate.tokens)} токенов ({kTokens(estimate.tokensPerCell)} на ячейку,{' '}
        {estimate.tokensPerCellSource === 'history' ? 'по истории прогонов' : 'по конфигу'})
        {estimate.busy > 0 && <span className="muted"> · уже в очереди: {estimate.busy}</span>}
      </div>
      {over.length > 0 && (
        <div className="warn">
          {over.length} сессий могут превысить лимит {kTokens(estimate.maxTokensPerRun)} токенов на прогон — уменьшите matrix.batch_size или поднимите limits.max_tokens_per_run.
        </div>
      )}
      <details>
        <summary>Сессии</summary>
        <table className="grid compact">
          <tbody>
            {estimate.batches.map((b, i) => (
              <tr key={i}>
                <td>{b.moduleName}</td>
                <td>{b.group || '—'}</td>
                <td>{b.cells}</td>
                <td>≈{kTokens(b.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <div className="row">
        <IconButton icon="play" className="primary" title="Поставить сессии в очередь" label="Запустить" disabled={!estimate.cells} onClick={onRun} />
        <button onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}

function CellBadge({ c }: { c: Cell }) {
  return (
    <span className="cell-badge">
      <span className={`status cs-${c.status.replace('/', '')}`}>{cellLabel(c)}</span>
      {c.stale && (
        <span className="status stale" title={c.staleReasons.map((r) => STALE_REASON[r]).join(', ')}>
          устарело
        </span>
      )}
      {c.findingCount > 0 && (
        <span className="status cs-finding" title={`находок: ${c.findingCount}`}>
          <Icon name="finding" size={12} /> {c.findingCount}
        </span>
      )}
      {c.activeJob && <span className={`status s-${c.activeJob.status}`}>{JOB_STATUS[c.activeJob.status]}</span>}
    </span>
  );
}

type Pending =
  | { kind: 'stage'; stage: MatrixStage; scope: MatrixScope; estimate: MatrixEstimate }
  | { kind: 'cells'; cells: string[]; title: string; estimate: MatrixEstimate };

type RowFilter = 'all' | 'stale' | 'finding' | 'not_checked';
type Req = MatrixView['requirements'][number];

const cellLabel = (c: Cell) => (c.status === 'not_checked' && c.triaged ? 'применимо' : CELL_STATUS[c.status]);
// Sorting a module column puts work first: unchecked, then findings, then the rest.
const CELL_RANK: Record<string, number> = { not_checked: 0, needs_human: 1, finding: 2, pass: 3, 'n/a': 4 };

export function MatrixTab({ project, revision, run, selection, onSelect }: Props) {
  const [matrices, setMatrices] = useState<Matrix[]>([]);
  const [matrixId, setMatrixId] = useState<string | null>(null);
  const [view, setView] = useState<MatrixView | null>(null);
  const [form, setForm] = useState<'new' | 'edit' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [filter, setFilter] = useState<RowFilter>('all');

  useEffect(() => {
    void run(api.listMatrices(project.id)).then((ms) => {
      if (!ms) return;
      setMatrices(ms);
      setMatrixId((cur) => (cur && ms.some((m) => m.id === cur) ? cur : (ms[0]?.id ?? null)));
    });
  }, [project.id, revision, run]);

  useEffect(() => {
    if (!matrixId) return setView(null);
    void run(api.matrixView(project.id, matrixId)).then((v) => setView(v ?? null));
  }, [project.id, matrixId, revision, run]);

  const estimate = async (stage: MatrixStage, scope: MatrixScope) => {
    if (!matrixId) return;
    const e = await run(api.estimateMatrix(project.id, matrixId, stage, scope));
    if (e) setPending({ kind: 'stage', stage, scope, estimate: e });
  };
  const start = async () => {
    if (!pending || !matrixId) return;
    await run(
      pending.kind === 'stage' ? api.runMatrix(project.id, matrixId, pending.stage, pending.scope) : api.recheckCells(project.id, pending.cells, matrixId),
    );
    setPending(null);
  };

  const matrix = matrices.find((m) => m.id === matrixId);
  const cellMap = new Map((view?.cells ?? []).map((c) => [`${c.moduleId}/${c.requirementId}`, c]));
  const cellOf = (moduleId: string, requirementId: string) => cellMap.get(`${moduleId}/${requirementId}`);

  /** Verdicts for a slice of the matrix: its unchecked and stale cells, or all of them when none is left. */
  const runSlice = async (title: string, pairs: [string, string][]) => {
    if (!matrixId) return;
    const cells = pairs.map(([m, r]) => cellOf(m, r)).filter((c): c is Cell => Boolean(c && !c.activeJob));
    const todo = cells.filter((c) => c.status === 'not_checked' || c.stale);
    const ids = (todo.length ? todo : cells).map((c) => `${c.moduleId}/${c.requirementId}`);
    if (!ids.length) return;
    const e = await run(api.estimateRecheck(project.id, ids, matrixId));
    if (e) setPending({ kind: 'cells', cells: ids, title: `вердикты, ${title}`, estimate: e });
  };

  const modules = view?.modules ?? [];
  const rowShown = (r: Req) =>
    filter === 'all' ||
    modules.some((m) => {
      const c = cellOf(m.id, r.requirementId);
      return c && (filter === 'stale' ? c.stale : filter === 'finding' ? c.findingCount > 0 || c.status === 'finding' : c.status === 'not_checked');
    });
  const cols: Col<Req>[] = [
    { key: 'req', title: 'Требование', text: (r) => `${r.key} ${r.text}`, sort: (r) => r.key, className: 'req-col' },
    ...modules.map(
      (m): Col<Req> => ({
        key: m.id,
        title: m.name,
        text: (r) => {
          const c = cellOf(m.id, r.requirementId);
          return c ? cellLabel(c) : '';
        },
        sort: (r) => {
          const c = cellOf(m.id, r.requirementId);
          return c ? (c.stale ? -1 : (CELL_RANK[c.status] ?? 9)) : 99;
        },
        filter: 'enum',
        extra: (
          <IconButton
            icon="play"
            className="ghost col-run"
            title={`Вердикты по модулю ${m.name}: непроверенные и устаревшие ячейки`}
            onClick={() => void runSlice(`модуль ${m.name}`, (view?.requirements ?? []).map((r) => [m.id, r.requirementId]))}
          />
        ),
      }),
    ),
  ];
  const g = useGrid(`matrix.${matrixId}`, (view?.requirements ?? []).filter(rowShown), cols);

  const sections: { key: string; items: Req[] }[] = [];
  const byKey = new Map<string, Req[]>();
  for (const r of g.rows) {
    const key = `${r.documentTitle} · ${r.section || '—'}`;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      sections.push({ key, items: byKey.get(key)! });
    }
    byKey.get(key)!.push(r);
  }
  const counts = view && {
    stale: view.cells.filter((c) => c.stale).length,
    byStatus: (Object.keys(CELL_STATUS) as Cell['status'][]).map((k) => [k, view.cells.filter((c) => c.status === k).length] as const),
  };
  const rowPairs = (r: Req) => modules.map((m): [string, string] => [m.id, r.requirementId]);

  return (
    <div className="matrix-tab">
      <div className="toolbar">
        <select aria-label="Матрица" value={matrixId ?? ''} onChange={(e) => (setMatrixId(e.target.value), setPending(null))}>
          {matrices.length === 0 && <option value="">нет матриц</option>}
          {matrices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <IconButton icon="plus" title="Новая матрица" aria-pressed={form === 'new'} onClick={() => setForm(form === 'new' ? null : 'new')} />
        {matrix && <IconButton icon="edit" title="Изменить состав матрицы" aria-pressed={form === 'edit'} onClick={() => setForm(form === 'edit' ? null : 'edit')} />}
        {matrix && (
          <span className="toolbar-group">
            <IconButton icon="triage" title="Этап 1: отсеять неприменимые ячейки (дешёвая модель)" label="Отсев n/a" onClick={() => void estimate('triage', 'pending')} />
            <IconButton
              icon="play"
              className="primary"
              title="Этап 2: вердикты для всех непроверенных ячеек матрицы"
              label="Вердикты"
              onClick={() => void estimate('verdicts', 'pending')}
            />
            <IconButton
              icon="recheck"
              title="Перепроверить устаревшие ячейки"
              label={`Устаревшие ${counts?.stale ?? 0}`}
              disabled={!counts?.stale}
              onClick={() => void estimate('verdicts', 'stale')}
            />
          </span>
        )}
      </div>
      {form && (
        <div className="card">
          <MatrixForm
            key={form}
            project={project}
            run={run}
            matrix={form === 'edit' ? matrix : undefined}
            onDone={(m) => {
              setForm(null);
              if (m) setMatrixId(m.id);
            }}
          />
        </div>
      )}
      {pending && (
        <EstimatePanel estimate={pending.estimate} title={pending.kind === 'cells' ? pending.title : undefined} onRun={() => void start()} onCancel={() => setPending(null)} />
      )}
      {!matrix ? (
        <div className="empty">Матриц нет. Загрузите и утвердите документ на вкладке «Документы», затем создайте матрицу.</div>
      ) : !view ? null : (
        <>
          <div className="toolbar legend" role="group" aria-label="Строки">
            <span className="mono muted" title="коммит, на котором показаны вердикты">
              HEAD {view.head.slice(0, 8)}
            </span>
            {counts!.byStatus.map(([k, n]) => {
              const f = k === 'not_checked' ? 'not_checked' : k === 'finding' ? 'finding' : null;
              const chip = (
                <>
                  <span className={`status cs-${k.replace('/', '')}`}>{CELL_STATUS[k]}</span> {n}
                </>
              );
              return f ? (
                <button key={k} className="chip" aria-pressed={filter === f} title="Показать строки с такими ячейками" onClick={() => setFilter(filter === f ? 'all' : f)}>
                  {chip}
                </button>
              ) : (
                <span key={k} className="chip static">
                  {chip}
                </span>
              );
            })}
            <button className="chip" aria-pressed={filter === 'stale'} title="Показать строки с устаревшими ячейками" onClick={() => setFilter(filter === 'stale' ? 'all' : 'stale')}>
              <span className="status stale">устарело</span> {counts!.stale}
            </button>
            {g.count}
          </div>
          <div className="matrix-scroll">
            <table className="grid matrix-grid">
              {g.head}
              <tbody>
                {g.rows.length === 0 && (
                  <EmptyRow colSpan={g.colSpan} filtered>
                    —
                  </EmptyRow>
                )}
                {sections.map((sec) => (
                  <Fragment key={sec.key}>
                    <tr className="section-row">
                      <td colSpan={g.colSpan}>
                        <span>{sec.key}</span>
                        <IconButton
                          icon="play"
                          className="ghost row-run"
                          title={`Вердикты по разделу: ${sec.items.length} требований`}
                          onClick={() => void runSlice(`раздел ${sec.key}`, sec.items.flatMap(rowPairs))}
                        />
                      </td>
                    </tr>
                    {sec.items.map((r) => (
                      <tr key={r.requirementId}>
                        <td className="req-cell">
                          <div className="req-line">
                            <span>
                              <span className="mono">{r.key}</span> {r.text}
                            </span>
                            <IconButton icon="play" className="ghost row-run" title={`Вердикты по требованию ${r.key}`} onClick={() => void runSlice(`требование ${r.key}`, rowPairs(r))} />
                          </div>
                        </td>
                        {modules.map((m) => {
                          const c = cellOf(m.id, r.requirementId);
                          const id = `${m.id}/${r.requirementId}`;
                          return (
                            <td
                              key={m.id}
                              tabIndex={0}
                              className={selection?.kind === 'cell' && selection.id === id ? 'selected matrix-cell' : 'matrix-cell'}
                              onClick={() => onSelect({ kind: 'cell', id, matrixId: matrix.id })}
                              onKeyDown={(e) => e.key === 'Enter' && onSelect({ kind: 'cell', id, matrixId: matrix.id })}
                            >
                              {c && <CellBadge c={c} />}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
