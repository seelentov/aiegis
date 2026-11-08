import { useEffect, useState } from 'react';
import { SEVERITIES, type CellStatus, type DiffCheckInput, type DiffCheckSummary, type DiffCheckTarget, type DiffCheckView, type DocSet, type DocumentSummary, type MatrixEstimate, type ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { CELL_STATUS, SEVERITY, time } from '../format';
import { EvidenceList } from './AuditDetails';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { useReveal } from '../reveal';
import { EstimatePanel } from './MatrixTab';
import { tr } from '../i18n';
import { IconButton, Select, Table } from '../ui';

export interface DiffFieldsValue {
  baseRef: string;
  headRef: string;
  /** `set:<id>` or `doc:<id>`, empty until chosen. */
  target: string;
}

export const EMPTY_DIFF: DiffFieldsValue = { baseRef: '', headRef: '', target: '' };
export const diffFieldsOf = (i: DiffCheckInput): DiffFieldsValue => ({ baseRef: i.baseRef, headRef: i.headRef, target: 'setId' in i.target ? `set:${i.target.setId}` : `doc:${i.target.documentId}` });
const targetOf = (v: string): DiffCheckTarget => (v.startsWith('set:') ? { setId: v.slice(4) } : { documentId: v.slice(4) });
export const diffInputOf = (v: DiffFieldsValue): DiffCheckInput => ({ baseRef: v.baseRef, headRef: v.headRef, target: targetOf(v.target) });
export const diffReady = (v: DiffFieldsValue) => Boolean(v.baseRef && v.headRef && v.target && v.baseRef !== v.headRef);

/** Branches and the set or document to check against; the tab and the schedule form share them. */
export function DiffFields({ project, run, value, onChange }: { project: ProjectInfo; run: RunFn; value: DiffFieldsValue; onChange: (v: DiffFieldsValue) => void }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [sets, setSets] = useState<DocSet[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);

  useEffect(() => {
    void run(api.listBranches(project.id)).then((b) => b && setBranches(b));
    void run(api.listDocSets(project.id)).then((x) => x && setSets(x));
    void run(api.listDocuments(project.id)).then((x) => x && setDocuments(x.filter((d) => d.current && !d.retiredAt)));
  }, [project.id, run]);

  const branch = (title: string, key: 'baseRef' | 'headRef') => (
    <label>
      {title}
      <Select value={value[key]} onChange={(v) => onChange({ ...value, [key]: v })}>
        <option value="" />
        {/* A schedule keeps its branch after the branch is gone: it stays visible, the firing reports the error. */}
        {[...new Set([...branches, ...(value[key] ? [value[key]] : [])])].map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </Select>
    </label>
  );
  return (
    <>
      {branch(tr('Target branch'), 'baseRef')}
      {branch(tr('Branch to check'), 'headRef')}
      <label>
        {tr('Set or document')}
        <Select value={value.target} onChange={(v) => onChange({ ...value, target: v })}>
          <option value="" />
          <optgroup label={tr('Sets')}>
            {sets.map((d) => (
              <option key={d.id} value={`set:${d.id}`}>
                {d.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={tr('Documents')}>
            {documents.map((d) => (
              <option key={d.id} value={`doc:${d.id}`}>
                {d.title}
              </option>
            ))}
          </optgroup>
        </Select>
      </label>
    </>
  );
}

const STATUS_ORDER: CellStatus[] = ['finding', 'needs_human', 'not_checked', 'pass', 'n/a'];
const statusClass = (s: CellStatus) => `status cs-${s.replace('/', '')}`;

function Counts({ c }: { c: DiffCheckSummary }) {
  return (
    <span className="row">
      {STATUS_ORDER.filter((s) => c.counts[s]).map((s) => (
        <span key={s} className={statusClass(s)}>
          {CELL_STATUS[s]} {c.counts[s]}
        </span>
      ))}
      {c.activeJobs > 0 && <span className="muted small">{tr('sessions running: {n}', { n: c.activeJobs })}</span>}
    </span>
  );
}

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}

export function DiffTab({ project, revision, run, selection, onSelect }: Props) {
  const [form, setForm] = useState(EMPTY_DIFF);
  const [estimate, setEstimate] = useState<MatrixEstimate | null>(null);
  const [checks, setChecks] = useState<DiffCheckSummary[]>([]);
  const [checkId, setCheckId] = useState<string | null>(null);
  const [view, setView] = useState<DiffCheckView | null>(null);

  useEffect(() => {
    void run(api.listDiffChecks(project.id)).then((c) => c && setChecks(c));
  }, [project.id, revision, run]);

  useEffect(() => {
    if (!checkId) return setView(null);
    void run(api.diffCheckView(project.id, checkId)).then((v) => setView(v ?? null));
  }, [project.id, checkId, revision, run]);

  const start = async () => {
    setEstimate(null);
    const r = await run(api.runDiffCheck(project.id, diffInputOf(form)));
    if (r) setCheckId(r.check.id);
  };

  useReveal(
    (key) => {
      const id = key.startsWith('diff-check:') ? key.slice('diff-check:'.length) : null;
      if (!id || !checks.some((x) => x.id === id)) return false;
      setCheckId(id);
      // Not taken: the checks grid, whose effect runs after this one, brings the row into view.
      return false;
    },
    [checks],
  );
  const c = useGrid('diff-checks', checks, [
    { key: 'branch', title: tr('Branches'), text: (x) => `${x.headRef} → ${x.baseRef}` },
    { key: 'target', title: tr('Set or document'), text: (x) => x.title, filter: 'enum' },
    { key: 'commit', title: tr('Commit'), text: (x) => x.headSha.slice(0, 8) },
    { key: 'files', title: tr('Files'), text: (x) => String(x.files.length), sort: (x) => x.files.length },
    { key: 'result', title: tr('Result') },
    { key: 'created', title: tr('Created'), text: (x) => `${time(x.createdAt)} ${x.author}`, sort: (x) => x.createdAt },
  ], { revealKey: (x) => `diff-check:${x.id}` });
  type Row = DiffCheckView['rows'][number];
  const status = (r: Row): CellStatus => r.verdict?.status ?? 'not_checked';
  const r = useGrid('diff-rows', view?.rows ?? [], [
    { key: 'key', title: tr('Requirement'), text: (x: Row) => `${x.item.key} ${x.item.text}`, sort: (x: Row) => x.item.key },
    { key: 'document', title: tr('Document'), text: (x: Row) => x.documentTitle, filter: 'enum' },
    { key: 'status', title: tr('Status'), text: (x: Row) => CELL_STATUS[status(x)], sort: (x: Row) => STATUS_ORDER.indexOf(status(x)), filter: 'enum' },
    { key: 'severity', title: 'Severity', text: (x: Row) => (x.verdict?.severity ? SEVERITY[x.verdict.severity] : ''), sort: (x: Row) => (x.verdict?.severity ? SEVERITIES.indexOf(x.verdict.severity) : SEVERITIES.length), filter: 'enum' },
    { key: 'reason', title: tr('Reason'), text: (x: Row) => x.verdict?.reason ?? '' },
  ]);

  return (
    <div className="diff-tab">
      <div className="form diff-form">
        <DiffFields project={project} run={run} value={form} onChange={(v) => (setForm(v), setEstimate(null))} />
        <IconButton
          icon="play"
          variant="primary"
          title={tr('Estimate the check, then run it')}
          label={tr('Check')}
          disabled={!diffReady(form)}
          onClick={() => void run(api.estimateDiffCheck(project.id, diffInputOf(form))).then((e) => e && setEstimate(e))}
        />
      </div>
      {estimate && <EstimatePanel estimate={estimate} title={tr('branch check')} batchSetting="diff_check.batch_size" onRun={() => void start()} onCancel={() => setEstimate(null)} />}
      <Table>
        {c.head}
        <tbody>
          {c.rows.length === 0 && (
            <EmptyRow colSpan={c.colSpan} filtered={c.filtered}>
              {tr('No checks: pick two branches and what to check them against')}
            </EmptyRow>
          )}
          {c.rows.map((x) => (
            <tr key={x.id} className={checkId === x.id ? 'selected' : ''} onClick={() => setCheckId(x.id)}>
              <td className="mono">
                {x.headRef} → {x.baseRef}
              </td>
              <td>{x.title}</td>
              <td className="mono">{x.headSha.slice(0, 8)}</td>
              <td>{x.files.length}</td>
              <td>
                <Counts c={x} />
              </td>
              <td className="small">
                {time(x.createdAt)}
                <div className="muted">{x.author}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {c.pager}
      {view && (
        <>
        <Table className="diff-rows">
          {r.head}
          <tbody>
            {r.rows.length === 0 && <EmptyRow colSpan={r.colSpan} filtered={r.filtered}>{tr('No requirements')}</EmptyRow>}
            {r.rows.map((x) => {
              const id = `${view.check.id}/${x.item.id}`;
              return (
                <tr key={id} className={selection?.kind === 'diff' && selection.id === id ? 'selected' : ''} onClick={() => onSelect({ kind: 'diff', id })}>
                  <td>
                    <strong className="mono">{x.item.key}</strong> {x.item.text}
                  </td>
                  <td>{x.documentTitle}</td>
                  <td>
                    <span className={statusClass(status(x))}>{CELL_STATUS[status(x)]}</span>
                  </td>
                  <td>{x.verdict?.severity && <span className={`status sev-${x.verdict.severity}`}>{SEVERITY[x.verdict.severity]}</span>}</td>
                  <td className="small">{x.verdict?.reason}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {r.pager}
        </>
      )}
    </div>
  );
}

/** Selected requirement of a check in the details panel; `id` is `<check>/<item>`. */
export function DiffDetailsView({ project, id, revision, run, onTerminal }: { project: ProjectInfo; id: string; revision: number; run: RunFn; onTerminal: (id: string | undefined) => void }) {
  const [view, setView] = useState<DiffCheckView | null>(null);
  const [checkId, itemId] = id.split('/');

  useEffect(() => {
    void run(api.diffCheckView(project.id, checkId)).then((v) => setView(v ?? null));
  }, [project.id, checkId, revision, run]);

  const row = view?.rows.find((x) => x.item.id === itemId);
  if (!view || !row) return null;
  const v = row.verdict;
  const st = v?.status ?? 'not_checked';
  return (
    <section>
      <h3>
        <span className="mono">{row.item.key}</span> {row.documentTitle}
      </h3>
      <p>{row.item.text}</p>
      <dl>
        <dt>{tr('Branches')}</dt>
        <dd className="mono small">
          {view.check.headRef} → {view.check.baseRef}
        </dd>
        <dt>{tr('Commit')}</dt>
        <dd className="mono small">
          {view.check.baseSha.slice(0, 8)}..{view.check.headSha.slice(0, 8)}
        </dd>
        <dt>{tr('Status')}</dt>
        <dd>
          <span className={statusClass(st)}>{CELL_STATUS[st]}</span>
          {v?.severity && <span className={`status sev-${v.severity}`}> {SEVERITY[v.severity]}</span>}
        </dd>
        {v && (
          <>
            <dt>{tr('Reason')}</dt>
            <dd>{v.reason}</dd>
            <dt>{tr('Evidence')}</dt>
            <dd>
              <EvidenceList project={project} run={run} items={v.evidence} />
            </dd>
          </>
        )}
      </dl>
      {v?.runId && (
        <div className="actions">
          <IconButton icon="terminal" title={tr('Open the verdict session')} onClick={() => void run(api.openRun(project.id, v.runId!)).then(onTerminal)} />
        </div>
      )}
    </section>
  );
}
