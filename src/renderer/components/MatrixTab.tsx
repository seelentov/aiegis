import { Fragment, useEffect, useState } from 'react';
import { VERDICT_STATUSES, type VerdictStatus } from '../../shared/types';
import type { Cell, DocSet, DocumentSummary, Matrix, MatrixEstimate, MatrixScope, MatrixSlice, MatrixStage, MatrixView, ModuleSummary, ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { CELL_STATUS, JOB_STATUS, kTokens, STALE_REASON } from '../format';
import { parseEvidence } from './AuditDetails';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid, type Col } from './Grid';
import { Icon } from './Icon';
import { showMenu, type MenuEntry } from '../menu';
import { useReveal } from '../reveal';
import { tr } from '../i18n';
import { Button, Checkbox, IconButton, Input, Select, Table, Textarea } from '../ui';

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
  const [sets, setSets] = useState<DocSet[]>([]);
  useEffect(() => {
    void api.listDocuments(project.id).then(setAllDocs);
    void api.listDocSets(project.id).then(setSets);
    void api.listModules(project.id).then(setAllMods);
  }, [project.id]);
  const toggle = (list: string[], set: (x: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const setDocsOf = (id: string) => allDocs.filter((d) => d.setId === id && d.current).map((d) => d.id);
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
      <div className="wide matrix-pick">
        <fieldset>
          <legend>{tr('Documents (approved versions)')}</legend>
          {sets.map((set) => {
            const ids = setDocsOf(set.id);
            const all = ids.length > 0 && ids.every((id) => docs.includes(id));
            return (
              <label key={set.id} className="check">
                <Checkbox checked={all} disabled={!ids.length} onChange={() => setDocs(all ? docs.filter((id) => !ids.includes(id)) : [...new Set([...docs, ...ids])])} />
                <strong>{tr('Set: {name}', { name: set.name })}</strong> <span className="muted">{ids.length}</span>
              </label>
            );
          })}
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
      </div>
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
export function EstimatePanel({ estimate, title, batchSetting = 'matrix.batch_size', perFinding, perFile, onSwitch, onBuildMaps, onRun, onCancel }: { estimate: MatrixEstimate; title?: string; batchSetting?: string; perFinding?: boolean; perFile?: boolean; onSwitch?: () => void; onBuildMaps?: () => void; onRun: () => void; onCancel: () => void }) {
  const over = estimate.batches.filter((b) => b.tokens > estimate.maxTokensPerRun);
  const counts = {
    sessions: estimate.sessions,
    cells: estimate.cells,
    tokens: kTokens(estimate.tokens),
    perCell: kTokens(estimate.tokensPerCell),
    source: estimate.tokensPerCellSource === 'history' ? tr('from run history') : tr('from config'),
  };
  const g = useGrid('estimate.sessions', estimate.batches, [
    { key: 'module', title: tr('Module'), text: (b) => b.moduleName, filter: 'enum' },
    { key: 'group', title: tr('Group'), text: (b) => b.group || '—', filter: 'enum' },
    { key: 'cells', title: perFile ? tr('Files') : tr('Cells'), text: (b) => String(b.cells), sort: (b) => b.cells, filter: 'none' },
    { key: 'tokens', title: tr('Tokens'), text: (b) => kTokens(b.tokens), sort: (b) => b.tokens, filter: 'none' },
  ]);
  return (
    <div className="card estimate">
      <strong>
        {tr('Estimate: {title} (role {role})', { title: title ?? STAGE_TITLE[estimate.stage], role: estimate.role })}
      </strong>
      <div>
        {perFinding
          ? tr('Findings: {sessions}, one session each · ≈{tokens} tokens ({perCell} per finding, {source})', { sessions: estimate.sessions, tokens: kTokens(estimate.tokens), perCell: kTokens(estimate.tokensPerCell), source: estimate.tokensPerCellSource === 'history' ? tr('from run history') : tr('from config') })
          : perFile
            ? tr('Sessions: {sessions} · files: {cells} · ≈{tokens} tokens ({perCell} per file, {source})', counts)
            : tr('Sessions: {sessions} · cells: {cells} · ≈{tokens} tokens ({perCell} per cell, {source})', counts)}
        {estimate.busy > 0 && <span className="muted"> · {tr('already queued: {n}', { n: estimate.busy })}</span>}
      </div>
      {over.length > 0 && (
        <div className="warn">
          {tr('{n} sessions may exceed the limit of {limit} tokens per run: lower {setting} or raise limits.max_tokens_per_run.', { n: over.length, limit: kTokens(estimate.maxTokensPerRun), setting: batchSetting })}
        </div>
      )}
      {!!estimate.modulesWithoutMap?.length && (
        <div className="row">
          <span className="warn">{tr('No entry point map: {modules}. Sessions of these modules will search the code without it.', { modules: estimate.modulesWithoutMap.map((m) => m.name).join(', ') })}</span>
          {onBuildMaps && <Button onClick={onBuildMaps}>{tr('Build maps')}</Button>}
        </div>
      )}
      <details>
        <summary>{tr('Sessions')}</summary>
        <Table compact>
          {g.head}
          <tbody>
            {g.rows.map((b, i) => (
              <tr key={i}>
                <td>{b.moduleName}</td>
                <td>{b.group || '—'}</td>
                <td>{b.cells}</td>
                <td>≈{kTokens(b.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {g.pager}
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

/** One manual verdict for every cell of a slice, all or none. */
function BulkVerdictForm({ project, run, title, cells, onDone }: { project: ProjectInfo; run: RunFn; title: string; cells: string[]; onDone: () => void }) {
  const [status, setStatus] = useState<VerdictStatus>('n/a');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const save = async () => {
    if (await run(api.setVerdicts(project.id, cells, { status, reason, evidence: parseEvidence(evidence) }))) onDone();
  };
  return (
    <div className="card">
      <strong>{tr('Verdict for {n} cells: {scope}', { n: cells.length, scope: title })}</strong>
      <div className="form">
        <label>
          {tr('Status')}
          <Select value={status} onChange={setStatus}>
            {VERDICT_STATUSES.map((x) => (
              <option key={x} value={x}>
                {CELL_STATUS[x]}
              </option>
            ))}
          </Select>
        </label>
        <div />
        <label className="wide">
          {tr('Rationale')}
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="wide">
          {tr('Code (one per line: path[:line] [note], from the repository root)')}
          <Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </label>
        <div className="wide row">
          <Button variant="primary" disabled={!reason.trim() || !cells.length} onClick={() => void save()}>
            {tr('Save')}
          </Button>
          <Button onClick={onDone}>{tr('Cancel')}</Button>
        </div>
      </div>
    </div>
  );
}

type Pending =
  | { kind: 'stage'; stage: MatrixStage; scope: MatrixScope; estimate: MatrixEstimate; force: boolean; slice?: MatrixSlice; title?: string }
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
  const [bulk, setBulk] = useState<{ title: string; cells: string[] } | null>(null);
  useReveal(
    (key) => {
      const id = key.startsWith('matrix:') ? key.slice('matrix:'.length) : null;
      if (!id || !matrices.some((m) => m.id === id)) return false;
      setMatrixId(id);
      return true;
    },
    [matrices],
  );

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

  const estimate = async (stage: MatrixStage, scope: MatrixScope, force = false, slice?: MatrixSlice, title?: string) => {
    if (!matrixId) return;
    const e = await run(api.estimateMatrix(project.id, matrixId, stage, scope, force, slice));
    if (e) setPending({ kind: 'stage', stage, scope, estimate: e, force, slice, title });
  };
  const estimateCells = async (cells: string[], title: string, force: boolean) => {
    const e = await run(api.estimateRecheck(project.id, cells, matrixId ?? undefined, force));
    if (e) setPending({ kind: 'cells', cells, title, estimate: e, force });
  };
  const switchMode = () => {
    if (!pending) return;
    if (pending.kind === 'stage') void estimate(pending.stage, pending.scope, !pending.force, pending.slice, pending.title);
    else void estimateCells(pending.cells, pending.title, !pending.force);
  };
  const buildMaps = async () => {
    if (!pending) return;
    await run(Promise.all((pending.estimate.modulesWithoutMap ?? []).map((m) => api.enqueueEntryPoints(project.id, m.id))));
    setPending(null);
  };
  const start = async () => {
    if (!pending || !matrixId) return;
    await run(
      pending.kind === 'stage' ? api.runMatrix(project.id, matrixId, pending.stage, pending.scope, pending.force, pending.slice) : api.recheckCells(project.id, pending.cells, matrixId, pending.force),
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

  /** Actions of a slice: the right-click menu and the ⋯ button show the same list. */
  const actions = (title: string, slice: MatrixSlice, cells: () => string[]): MenuEntry[] => [
    { label: tr('Verdicts'), run: () => void runSlice(title, slice) },
    { label: tr('n/a triage'), run: () => void estimate('triage', 'pending', false, slice, tr('n/a triage, {scope}', { scope: title })) },
    null,
    { label: tr('Set a verdict…'), run: () => setBulk({ title, cells: cells() }) },
  ];
  const cellsOf = (moduleIds: string[] | null, requirementIds: string[] | null) =>
    (view?.cells ?? []).filter((c) => (!moduleIds || moduleIds.includes(c.moduleId)) && (!requirementIds || requirementIds.includes(c.requirementId))).map((c) => `${c.moduleId}/${c.requirementId}`);
  const moduleActions = (m: MatrixView['modules'][number]) => actions(tr('module {name}', { name: m.name }), { modules: [m.id] }, () => cellsOf([m.id], null));
  const reqActions = (r: Req) => actions(tr('requirement {key}', { key: r.key }), { requirements: [r.requirementId] }, () => cellsOf(null, [r.requirementId]));
  const sectionActions = (key: string) => {
    const ids = (wholeSection.get(key) ?? []).map((r) => r.requirementId);
    return actions(tr('section {key}', { key }), { requirements: ids }, () => cellsOf(null, ids));
  };
  const cellActions = (moduleId: string, r: Req) => {
    const m = view?.modules.find((x) => x.id === moduleId);
    return actions(tr('cell {key} × {name}', { key: r.key, name: m?.name ?? moduleId }), { modules: [moduleId], requirements: [r.requirementId] }, () => [`${moduleId}/${r.requirementId}`]);
  };
  const actionsButton = (className: string, title: string, entries: () => MenuEntry[]) => (
    <IconButton icon="more" variant="ghost" className={className} title={tr('Actions: {scope}', { scope: title })} onClick={(e) => showMenu(e, entries())} />
  );

  const modules = view?.modules ?? [];
  const rowShown = (r: Req) =>
    filter === 'all' ||
    modules.some((m) => {
      const c = cellOf(m.id, r.requirementId);
      return c && (filter === 'stale' ? c.stale : filter === 'preliminary' ? c.preliminary : filter === 'finding' ? c.findingCount > 0 || c.status === 'finding' : c.status === 'not_checked');
    });
  const cols: Col<Req>[] = [
    // The text filter also matches the document title and section.
    { key: 'req', title: tr('Requirement'), text: (r) => `${r.key} ${r.text} ${r.documentTitle} ${r.section}`, sort: (r) => r.key, className: 'req-col' },
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
        menu: () => moduleActions(m),
        extra: actionsButton('col-run', tr('module {name}', { name: m.name }), () => moduleActions(m)),
      }),
    ),
  ];
  const reqs = view?.requirements ?? [];
  const g = useGrid(`matrix.${matrixId}`, reqs.filter(rowShown), cols, {
    menu: (target) => {
      const el = target.closest<HTMLElement>('[data-cell], [data-req], [data-section]');
      if (el?.dataset.section !== undefined) return sectionActions(el.dataset.section);
      const r = reqs.find((x) => x.requirementId === (el?.closest<HTMLElement>('[data-req]')?.dataset.req));
      if (!r) return [];
      return el?.dataset.cell ? cellActions(el.dataset.cell, r) : reqActions(r);
    },
  });

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
      {bulk && <BulkVerdictForm key={bulk.title} project={project} run={run} {...bulk} onDone={() => setBulk(null)} />}
      {pending && (
        <EstimatePanel estimate={pending.estimate} title={pending.title} onSwitch={switchMode} onBuildMaps={() => void buildMaps()} onRun={() => void start()} onCancel={() => setPending(null)} />
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
                    <tr className="section-row" data-section={sec.key}>
                      <td colSpan={g.colSpan}>
                        <span>{sec.key}</span>
                        {actionsButton('row-run', tr('section {key}', { key: sec.key }), () => sectionActions(sec.key))}
                      </td>
                    </tr>
                    {sec.items.map((r) => (
                      <tr key={r.requirementId} data-req={r.requirementId}>
                        <td className="req-cell">
                          <div className="req-line">
                            <span>
                              <span className="mono">{r.key}</span> {r.text}
                            </span>
                            {actionsButton('row-run', tr('requirement {key}', { key: r.key }), () => reqActions(r))}
                          </div>
                        </td>
                        {modules.map((m) => {
                          const c = cellOf(m.id, r.requirementId);
                          const id = `${m.id}/${r.requirementId}`;
                          return (
                            <td
                              key={m.id}
                              data-cell={m.id}
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
