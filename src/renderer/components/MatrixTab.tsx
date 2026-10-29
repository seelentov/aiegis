import { Fragment, useEffect, useState } from 'react';
import type { Cell, DocumentSummary, Matrix, MatrixEstimate, MatrixScope, MatrixStage, MatrixView, ModuleSummary, ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { CELL_STATUS, JOB_STATUS, kTokens, STALE_REASON } from '../format';
import type { Selection } from './DetailsPanel';

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
export function EstimatePanel({ estimate, onRun, onCancel }: { estimate: MatrixEstimate; onRun: () => void; onCancel: () => void }) {
  const over = estimate.batches.filter((b) => b.tokens > estimate.maxTokensPerRun);
  return (
    <div className="card estimate">
      <strong>
        Оценка: {STAGE_TITLE[estimate.stage]} (роль {estimate.role})
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
        <button className="primary" disabled={!estimate.cells} onClick={onRun}>
          Запустить
        </button>
        <button onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}

function CellBadge({ c }: { c: Cell }) {
  return (
    <span className="cell-badge">
      <span className={`status cs-${c.status.replace('/', '')}`}>{c.status === 'not_checked' && c.triaged ? 'применимо' : CELL_STATUS[c.status]}</span>
      {c.stale && (
        <span className="status stale" title={c.staleReasons.map((r) => STALE_REASON[r]).join(', ')}>
          устарело
        </span>
      )}
      {c.findingCount > 0 && <span className="status cs-finding">● {c.findingCount}</span>}
      {c.activeJob && <span className={`status s-${c.activeJob.status}`}>{JOB_STATUS[c.activeJob.status]}</span>}
    </span>
  );
}

export function MatrixTab({ project, revision, run, selection, onSelect }: Props) {
  const [matrices, setMatrices] = useState<Matrix[]>([]);
  const [matrixId, setMatrixId] = useState<string | null>(null);
  const [view, setView] = useState<MatrixView | null>(null);
  const [form, setForm] = useState<'new' | 'edit' | null>(null);
  const [pending, setPending] = useState<{ stage: MatrixStage; scope: MatrixScope; estimate: MatrixEstimate } | null>(null);
  const [filter, setFilter] = useState<'all' | 'stale' | 'finding' | 'not_checked'>('all');

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
    if (e) setPending({ stage, scope, estimate: e });
  };
  const start = async () => {
    if (!pending || !matrixId) return;
    await run(api.runMatrix(project.id, matrixId, pending.stage, pending.scope));
    setPending(null);
  };

  const matrix = matrices.find((m) => m.id === matrixId);
  const cellOf = (moduleId: string, requirementId: string) => view?.cells.find((c) => c.moduleId === moduleId && c.requirementId === requirementId);
  const counts = view && {
    stale: view.cells.filter((c) => c.stale).length,
    byStatus: Object.entries(CELL_STATUS).map(([k, label]) => [label, view.cells.filter((c) => c.status === k).length] as const),
  };
  const rowShown = (requirementId: string) =>
    filter === 'all' ||
    view!.modules.some((m) => {
      const c = cellOf(m.id, requirementId);
      return c && (filter === 'stale' ? c.stale : filter === 'finding' ? c.findingCount > 0 || c.status === 'finding' : c.status === 'not_checked');
    });
  const sections: { key: string; items: MatrixView['requirements'] }[] = [];
  for (const r of view?.requirements ?? []) {
    const key = `${r.documentTitle} · ${r.section || '—'}`;
    const last = sections[sections.length - 1];
    if (last?.key === key) last.items.push(r);
    else sections.push({ key, items: [r] });
  }

  return (
    <div className="matrix-tab">
      <div className="toolbar">
        <label>
          Матрица{' '}
          <select value={matrixId ?? ''} onChange={(e) => (setMatrixId(e.target.value), setPending(null))}>
            {matrices.length === 0 && <option value="">—</option>}
            {matrices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setForm(form === 'new' ? null : 'new')}>+ Матрица</button>
        {matrix && <button onClick={() => setForm(form === 'edit' ? null : 'edit')}>Изменить</button>}
        {matrix && (
          <>
            <button onClick={() => void estimate('triage', 'pending')}>Отсев n/a…</button>
            <button onClick={() => void estimate('verdicts', 'pending')}>Вердикты для непроверенных…</button>
            <button disabled={!counts?.stale} onClick={() => void estimate('verdicts', 'stale')}>
              Перепроверить устаревшие ({counts?.stale ?? 0})…
            </button>
          </>
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
      {pending && <EstimatePanel estimate={pending.estimate} onRun={() => void start()} onCancel={() => setPending(null)} />}
      {!matrix ? (
        <div className="empty">Матриц нет. Загрузите и утвердите документ на вкладке «Документы», затем создайте матрицу.</div>
      ) : !view ? null : (
        <>
          <div className="toolbar muted">
            HEAD <span className="mono">{view.head.slice(0, 8)}</span> ·{' '}
            {counts!.byStatus.map(([label, n]) => (
              <span key={label}>
                {label}: {n}{' '}
              </span>
            ))}
            · устарело: {counts!.stale}
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">все строки</option>
              <option value="not_checked">с непроверенными</option>
              <option value="stale">с устаревшими</option>
              <option value="finding">с находками</option>
            </select>
          </div>
          <table className="grid matrix-grid">
            <thead>
              <tr>
                <th>Требование</th>
                {view.modules.map((m) => (
                  <th key={m.id}>{m.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sections.map((sec) => (
                <Fragment key={sec.key}>
                  <tr className="section-row">
                    <td colSpan={view.modules.length + 1}>{sec.key}</td>
                  </tr>
                  {sec.items
                    .filter((r) => rowShown(r.requirementId))
                    .map((r) => (
                      <tr key={r.requirementId}>
                        <td className="req-cell">
                          <span className="mono">{r.key}</span> {r.text}
                        </td>
                        {view.modules.map((m) => {
                          const c = cellOf(m.id, r.requirementId);
                          const id = `${m.id}/${r.requirementId}`;
                          return (
                            <td
                              key={m.id}
                              className={selection?.kind === 'cell' && selection.id === id ? 'selected matrix-cell' : 'matrix-cell'}
                              onClick={() => onSelect({ kind: 'cell', id, matrixId: matrix.id })}
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
        </>
      )}
    </div>
  );
}
