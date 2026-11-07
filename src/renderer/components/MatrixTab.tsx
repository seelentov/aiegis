import { Fragment, useEffect, useState } from 'react';
import type { Cell, DocumentSummary, Matrix, MatrixEstimate, MatrixScope, MatrixSlice, MatrixStage, MatrixView, ModuleSummary, ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { CELL_STATUS, JOB_STATUS, kTokens, STALE_REASON } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid, type Col } from './Grid';
import { Icon } from './Icon';
import { tr } from '../i18n';
import { Button, Checkbox, IconButton, Input, Select, Table } from '../ui';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  draftDocument: string | null;
  onDraftTaken: () => void;
}

function MatrixForm({ project, run, matrix, documentId, onDone }: { project: ProjectInfo; run: RunFn; matrix?: Matrix; documentId?: string; onDone: (m?: Matrix) => void }) {
  const [name, setName] = useState(matrix?.name ?? '');
  const [docs, setDocs] = useState<string[]>(matrix?.documentIds ?? (documentId ? [documentId] : []));
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
        {tr('Title')}
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div />
      <fieldset>
        <legend>{tr('Documents (approved versions)')}</legend>
        {allDocs.map((d) => (
          <label key={d.id} className="check">
            <Checkbox checked={docs.includes(d.id)} disabled={!d.current} onChange={() => toggle(docs, setDocs, d.id)} />
            {d.title} {d.current ? <span className="muted">v{d.current.n}</span> : <span className="muted">{tr('(no approved version)')}</span>}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{tr('Modules (none selected means all)')}</legend>
        {allMods.map((m) => (
          <label key={m.id} className="check">
            <Checkbox checked={mods.includes(m.id)} onChange={() => toggle(mods, setMods, m.id)} />
            {m.name}
          </label>
        ))}
      </fieldset>
      <div className="wide row">
        <Button variant="primary" disabled={!name.trim() || !docs.length} onClick={() => void save()}>
          {tr('Save')}
        </Button>
        <Button onClick={() => onDone()}>{tr('Cancel')}</Button>
      </div>
    </div>
  );
}

const STAGE_TITLE: Record<MatrixStage, string> = { triage: tr('n/a triage'), verdicts: tr('Verdicts') };

/** Dry-run estimate shown before queuing a matrix stage (SPEC §7). */
export function EstimatePanel({ estimate, title, batchSetting = 'matrix.batch_size', perFinding, onSwitch, onRun, onCancel }: { estimate: MatrixEstimate; title?: string; batchSetting?: string; perFinding?: boolean; onSwitch?: () => void; onRun: () => void; onCancel: () => void }) {
  const over = estimate.batches.filter((b) => b.tokens > estimate.maxTokensPerRun);
  return (
    <div className="card estimate">
      <strong>
        {tr('Estimate: {title} (role {role})', { title: title ?? STAGE_TITLE[estimate.stage], role: estimate.role })}
      </strong>
      <div>
        {perFinding
          ? tr('Findings: {sessions}, one session each · ≈{tokens} tokens ({perCell} per finding, {source})', { sessions: estimate.sessions, tokens: kTokens(estimate.tokens), perCell: kTokens(estimate.tokensPerCell), source: estimate.tokensPerCellSource === 'history' ? tr('from run history') : tr('from config') })
          : tr('Sessions: {sessions} · cells: {cells} · ≈{tokens} tokens ({perCell} per cell, {source})', {
              sessions: estimate.sessions,
              cells: estimate.cells,
              tokens: kTokens(estimate.tokens),
              perCell: kTokens(estimate.tokensPerCell),
              source: estimate.tokensPerCellSource === 'history' ? tr('from run history') : tr('from config'),
            })}
        {estimate.busy > 0 && <span className="muted"> · {tr('already queued: {n}', { n: estimate.busy })}</span>}
      </div>
      {over.length > 0 && (
        <div className="warn">
          {tr('{n} sessions may exceed the limit of {limit} tokens per run: lower {setting} or raise limits.max_tokens_per_run.', { n: over.length, limit: kTokens(estimate.maxTokensPerRun), setting: batchSetting })}
        </div>
      )}
      <details>
        <summary>{tr('Sessions')}</summary>
        <Table compact>
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
        </Table>
      </details>
      {estimate.alternative && (
        <div className="row">
          <span className="muted">
            {estimate.mode === 'economy'
              ? tr('Merged sessions: cheaper, but they miss more and their verdicts are preliminary. As usual: {sessions} sessions, {tokens} tokens.', { sessions: estimate.alternative.sessions, tokens: kTokens(estimate.alternative.tokens) })
              : tr('Usual sessions. Merged: {sessions} sessions, {tokens} tokens, with preliminary verdicts.', { sessions: estimate.alternative.sessions, tokens: kTokens(estimate.alternative.tokens) })}
          </span>
          <Button onClick={onSwitch}>{estimate.mode === 'economy' ? tr('Run as usual') : tr('Use merged sessions')}</Button>
        </div>
      )}
      <div className="row">
        <IconButton icon="play" variant="primary" title={tr('Enqueue the sessions')} label={tr('Run')} disabled={!estimate.cells} onClick={onRun} />
        <Button onClick={onCancel}>{tr('Cancel')}</Button>
      </div>
    </div>
  );
}

function CellBadge({ c }: { c: Cell }) {
  return (
    <span className="cell-badge">
      <span className={`status cs-${c.status.replace('/', '')}`} title={c.preliminary ? tr('Preliminary verdict of a merged session') : undefined}>
        {cellLabel(c)}
        {c.preliminary ? ' *' : ''}
      </span>
      {c.stale && (
        <span className="status stale" title={c.staleReasons.map((r) => STALE_REASON[r]).join(', ')}>
          {tr('stale')}
        </span>
      )}
      {c.findingCount > 0 && (
        <span className="status cs-finding" title={tr('findings: {n}', { n: c.findingCount })}>
          <Icon name="finding" size={12} /> {c.findingCount}
        </span>
      )}
      {c.activeJob && <span className={`status s-${c.activeJob.status}`}>{JOB_STATUS[c.activeJob.status]}</span>}
    </span>
  );
}

type Pending =
  | { kind: 'stage'; stage: MatrixStage; scope: MatrixScope; estimate: MatrixEstimate; force: boolean }
  | { kind: 'cells'; cells: string[]; title: string; estimate: MatrixEstimate; force: boolean };

type RowFilter = 'all' | 'stale' | 'finding' | 'not_checked' | 'preliminary';
type Req = MatrixView['requirements'][number];

const cellLabel = (c: Cell) => (c.status === 'not_checked' && c.triaged ? tr('applicable') : CELL_STATUS[c.status]);
// Sorting a module column puts work first: unchecked, then findings, then the rest.
const CELL_RANK: Record<string, number> = { not_checked: 0, needs_human: 1, finding: 2, pass: 3, 'n/a': 4 };

export function MatrixTab({ project, revision, run, selection, onSelect, draftDocument, onDraftTaken }: Props) {
  const [matrices, setMatrices] = useState<Matrix[]>([]);
  const [matrixId, setMatrixId] = useState<string | null>(null);
  const [view, setView] = useState<MatrixView | null>(null);
  const [form, setForm] = useState<'new' | 'edit' | null>(draftDocument ? 'new' : null);
  const [draft, setDraft] = useState(draftDocument ?? undefined);
  useEffect(() => {
    if (draftDocument) onDraftTaken();
  }, [draftDocument, onDraftTaken]);
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

  const estimate = async (stage: MatrixStage, scope: MatrixScope, force = false) => {
    if (!matrixId) return;
    const e = await run(api.estimateMatrix(project.id, matrixId, stage, scope, force));
    if (e) setPending({ kind: 'stage', stage, scope, estimate: e, force });
  };
  const estimateCells = async (cells: string[], title: string, force: boolean) => {
    const e = await run(api.estimateRecheck(project.id, cells, matrixId ?? undefined, force));
    if (e) setPending({ kind: 'cells', cells, title, estimate: e, force });
  };
  const switchMode = () => {
    if (!pending) return;
    if (pending.kind === 'stage') void estimate(pending.stage, pending.scope, !pending.force);
    else void estimateCells(pending.cells, pending.title, !pending.force);
  };
  const start = async () => {
    if (!pending || !matrixId) return;
    await run(
      pending.kind === 'stage' ? api.runMatrix(project.id, matrixId, pending.stage, pending.scope, pending.force) : api.recheckCells(project.id, pending.cells, matrixId, pending.force),
    );
    setPending(null);
  };

  const matrix = matrices.find((m) => m.id === matrixId);
  const cellMap = new Map((view?.cells ?? []).map((c) => [`${c.moduleId}/${c.requirementId}`, c]));
  const cellOf = (moduleId: string, requirementId: string) => cellMap.get(`${moduleId}/${requirementId}`);

  /** Verdicts for a slice of the matrix. */
  const runSlice = async (title: string, slice: MatrixSlice, force = false) => {
    if (!matrixId) return;
    const ids = await run(api.matrixSlice(project.id, matrixId, slice));
    if (!ids?.length) return;
    await estimateCells(ids, tr('verdicts, {scope}', { scope: title }), force);
  };

  const modules = view?.modules ?? [];
  const rowShown = (r: Req) =>
    filter === 'all' ||
    modules.some((m) => {
      const c = cellOf(m.id, r.requirementId);
      return c && (filter === 'stale' ? c.stale : filter === 'preliminary' ? c.preliminary : filter === 'finding' ? c.findingCount > 0 || c.status === 'finding' : c.status === 'not_checked');
    });
  const cols: Col<Req>[] = [
    { key: 'req', title: tr('Requirement'), text: (r) => `${r.key} ${r.text}`, sort: (r) => r.key, className: 'req-col' },
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
            variant="ghost" className="col-run"
            title={tr('Verdicts for module {name}: unchecked and stale cells', { name: m.name })}
            onClick={() => void runSlice(tr('module {name}', { name: m.name }), { modules: [m.id] })}
          />
        ),
      }),
    ),
  ];
  const g = useGrid(`matrix.${matrixId}`, (view?.requirements ?? []).filter(rowShown), cols);

  const sectionOf = (r: Req) => `${r.documentTitle} · ${r.section || '—'}`;
  // The run button of a section covers all of it, also the rows on other pages.
  const wholeSection = new Map<string, Req[]>();
  for (const r of g.all) wholeSection.set(sectionOf(r), [...(wholeSection.get(sectionOf(r)) ?? []), r]);
  const sections: { key: string; items: Req[] }[] = [];
  const byKey = new Map<string, Req[]>();
  for (const r of g.rows) {
    const key = sectionOf(r);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      sections.push({ key, items: byKey.get(key)! });
    }
    byKey.get(key)!.push(r);
  }
  const counts = view && {
    stale: view.cells.filter((c) => c.stale).length,
    preliminary: view.cells.filter((c) => c.preliminary).length,
    byStatus: (Object.keys(CELL_STATUS) as Cell['status'][]).map((k) => [k, view.cells.filter((c) => c.status === k).length] as const),
  };

  return (
    <div className="matrix-tab">
      <div className="toolbar">
        <Select aria-label={tr('Matrix')} value={matrixId ?? ''} onChange={(v) => (setMatrixId(v), setPending(null))}>
          {matrices.length === 0 && <option value="">{tr('no matrices')}</option>}
          {matrices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <IconButton
          icon="plus"
          title={tr('New matrix')}
          aria-pressed={form === 'new'}
          onClick={() => {
            setDraft(undefined);
            setForm(form === 'new' ? null : 'new');
          }}
        />
        {matrix && <IconButton icon="edit" title={tr('Edit the matrix')} aria-pressed={form === 'edit'} onClick={() => setForm(form === 'edit' ? null : 'edit')} />}
        {matrix && (
          <span className="toolbar-group">
            <IconButton icon="triage" title={tr('Stage 1: filter out inapplicable cells (cheap model)')} label={tr('n/a triage')} onClick={() => void estimate('triage', 'pending')} />
            <IconButton
              icon="play"
              variant="primary"
              title={tr('Stage 2: verdicts for all unchecked cells of the matrix')}
              label={tr('Verdicts')}
              onClick={() => void estimate('verdicts', 'pending')}
            />
            <IconButton
              icon="recheck"
              title={tr('Recheck stale cells')}
              label={`${tr('Stale')} ${counts?.stale ?? 0}`}
              disabled={!counts?.stale}
              onClick={() => void estimate('verdicts', 'stale')}
            />
            {counts?.preliminary ? (
              <IconButton
                icon="recheck"
                title={tr('Check the preliminary cells again in usual sessions')}
                label={`${tr('Preliminary')} ${counts.preliminary}`}
                onClick={() => void runSlice(tr('preliminary'), { preliminary: true }, true)}
              />
            ) : null}
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
            documentId={form === 'new' ? draft : undefined}
            onDone={(m) => {
              setForm(null);
              setDraft(undefined);
              if (m) setMatrixId(m.id);
            }}
          />
        </div>
      )}
      {pending && (
        <EstimatePanel estimate={pending.estimate} title={pending.kind === 'cells' ? pending.title : undefined} onSwitch={switchMode} onRun={() => void start()} onCancel={() => setPending(null)} />
      )}
      {!matrix ? (
        <div className="empty">{tr('No matrices. Upload and approve a document on the “Documents” tab, then create a matrix.')}</div>
      ) : !view ? null : (
        <>
          <div className="toolbar legend" role="group" aria-label={tr('Rows')}>
            <span className="mono muted" title={tr('the commit the verdicts are shown for')}>
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
                <Button key={k} className="chip" aria-pressed={filter === f} title={tr('Show rows with such cells')} onClick={() => setFilter(filter === f ? 'all' : f)}>
                  {chip}
                </Button>
              ) : (
                <span key={k} className="chip static">
                  {chip}
                </span>
              );
            })}
            <Button className="chip" aria-pressed={filter === 'stale'} title={tr('Show rows with stale cells')} onClick={() => setFilter(filter === 'stale' ? 'all' : 'stale')}>
              <span className="status stale">{tr('stale')}</span> {counts!.stale}
            </Button>
            {counts!.preliminary > 0 && (
              <Button className="chip" aria-pressed={filter === 'preliminary'} title={tr('Show rows with verdicts of merged sessions')} onClick={() => setFilter(filter === 'preliminary' ? 'all' : 'preliminary')}>
                <span className="status stale">{tr('preliminary')}</span> {counts!.preliminary}
              </Button>
            )}
            {g.count}
          </div>
          <div className="matrix-scroll">
            <Table className="matrix-grid">
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
                          variant="ghost" className="row-run"
                          title={tr('Verdicts for the section: {n} requirements', { n: wholeSection.get(sec.key)!.length })}
                          onClick={() => void runSlice(tr('section {key}', { key: sec.key }), { requirements: wholeSection.get(sec.key)!.map((r) => r.requirementId) })}
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
                            <IconButton icon="play" variant="ghost" className="row-run" title={tr('Verdicts for requirement {key}', { key: r.key })} onClick={() => void runSlice(tr('requirement {key}', { key: r.key }), { requirements: [r.requirementId] })} />
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
            </Table>
          </div>
          {g.pager}
        </>
      )}
    </div>
  );
}
