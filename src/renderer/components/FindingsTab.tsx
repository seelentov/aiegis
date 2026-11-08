import { useEffect, useState } from 'react';
import type { Finding, FindingFixState, FindingStatus, MatrixEstimate, ModuleSummary, ProjectInfo } from '../../shared/types';
import { FINDING_STATUSES, SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { FINDING_STATUS, FINDING_VERIFY_OUTCOME, FIX_OUTCOME, SEVERITY, time } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { EstimatePanel } from './MatrixTab';
import { tr } from '../i18n';
import { Checkbox, IconButton, Input, Select, Table } from '../ui';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}

export function FindingsTab({ project, revision, run, selection, onSelect }: Props) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [docOf, setDocOf] = useState<Map<string, string>>(new Map());
  const [merged, setMerged] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<MatrixEstimate | null>(null);
  const [estimateFix, setEstimateFix] = useState(false);
  const [fixStates, setFixStates] = useState<Record<string, FindingFixState>>({});
  const [bulkStatus, setBulkStatus] = useState<FindingStatus>('verified');
  const [bulkReason, setBulkReason] = useState('');

  useEffect(() => {
    void run(api.listFindings(project.id)).then((f) => f && setFindings(f));
    void run(api.findingsFixState(project.id)).then((x) => x && setFixStates(x));
    void api.listModules(project.id).then(setModules);
    void api.currentRequirements(project.id).then((r) => setDocOf(new Map(r.map((i) => [i.requirementId, i.documentTitle]))));
  }, [project.id, revision, run]);

  const moduleName = (id: string | null) => modules.find((m) => m.id === id)?.name ?? '—';
  // shortcut: several documents join into one value, so the enum filter matches the exact combination.
  const documents = (f: Finding) => [...new Set(f.cells.map((c) => docOf.get(c.requirementId)).filter(Boolean))].sort().join(', ');
  const g = useGrid(
    'findings',
    findings.filter((f) => merged || !f.mergedInto),
    [
      { key: 'pick', title: '' },
      { key: 'title', title: tr('Finding'), text: (f) => `${f.title} ${f.entryPoint ?? ''}` , sort: (f) => f.title },
      { key: 'severity', title: 'Severity', text: (f) => SEVERITY[f.severity], sort: (f) => SEVERITIES.indexOf(f.severity), filter: 'enum' },
      { key: 'status', title: tr('Status'), text: (f) => FINDING_STATUS[f.status], filter: 'enum' },
      { key: 'verification', title: tr('Verification'), text: (f) => (f.verification ? FINDING_VERIFY_OUTCOME[f.verification] : ''), filter: 'enum' },
      { key: 'fix', title: tr('Fix check'), text: (f) => [fixStates[f.id]?.stale ? tr('stale|map') : '', fixStates[f.id]?.last ? FIX_OUTCOME[fixStates[f.id].last!] : ''].filter(Boolean).join(' · '), filter: 'enum' },
      { key: 'cwe', title: 'CWE', text: (f) => f.cwe ?? '' },
      { key: 'module', title: tr('Module'), text: (f) => moduleName(f.moduleId), filter: 'enum' },
      { key: 'document', title: tr('Document'), text: documents, filter: 'enum' },
      { key: 'links', title: tr('Links') },
      { key: 'created', title: tr('Created'), text: (f) => `${time(f.createdAt)} ${f.author}`, sort: (f) => f.createdAt },
    ],
    { revealKey: (f) => `finding:${f.id}` },
  );

  const eligible = (f: Finding) => f.status === 'suspected' && !f.mergedInto;
  const chosen = findings.filter((f) => picked.includes(f.id) && eligible(f)).map((f) => f.id);
  const stale = (f: Finding) => Boolean(fixStates[f.id]?.stale);
  const chosenFix = findings.filter((f) => picked.includes(f.id) && stale(f)).map((f) => f.id);
  // Any live finding can be picked; each action takes the picks it applies to.
  const pickable = (f: Finding) => !f.mergedInto;
  const chosenAny = findings.filter((f) => picked.includes(f.id) && pickable(f)).map((f) => f.id);
  const setStatus = async () => {
    if (await run(api.setFindingsStatus(project.id, chosenAny, bulkStatus, bulkReason))) (setPicked([]), setBulkReason(''));
  };
  const start = async () => {
    setEstimate(null);
    if (await run(estimateFix ? api.runFixVerify(project.id, chosenFix) : api.runFindingVerify(project.id, chosen))) setPicked([]);
  };

  return (
    <div className="findings-tab">
      <div className="toolbar">
        <label className="check">
          <Checkbox checked={merged} onChange={(e) => setMerged(e.target.checked)} /> {tr('show merged')}
        </label>
        <IconButton icon="checkAll" title={tr('Pick every finding that passes the filters, on every page')} label={tr('Pick all')} onClick={() => setPicked(g.all.filter(pickable).map((f) => f.id))} />
        <IconButton icon="clearFilter" title={tr('Clear the picks')} disabled={!picked.length} onClick={() => setPicked([])} />
        <IconButton icon="check" title={tr('Pick the suspected findings that pass the filters, on every page')} label={tr('Pick suspected')} onClick={() => setPicked(g.all.filter(eligible).map((f) => f.id))} />
        <IconButton
          icon="play"
          title={tr('Estimate, then run a clean session per picked finding that tries to refute it')}
          label={tr('Verify {n}', { n: chosen.length })}
          disabled={!chosen.length}
          onClick={() => void run(api.estimateFindingVerify(project.id, chosen)).then((e) => { setEstimateFix(false); if (e) setEstimate(e); })}
        />
        <IconButton icon="check" title={tr('Pick the stale findings that pass the filters, on every page')} label={tr('Pick stale')} onClick={() => setPicked(g.all.filter(stale).map((f) => f.id))} />
        <IconButton
          icon="play"
          title={tr('Estimate, then run a clean session per picked stale finding that judges at HEAD whether it is closed')}
          label={tr('Check fix {n}', { n: chosenFix.length })}
          disabled={!chosenFix.length}
          onClick={() => void run(api.estimateFixVerify(project.id, chosenFix)).then((e) => { setEstimateFix(true); if (e) setEstimate(e); })}
        />
        {g.count}
      </div>
      {chosenAny.length > 0 && (
        <div className="toolbar">
          <span>{tr('Picked: {n}', { n: chosenAny.length })}</span>
          <Select value={bulkStatus} onChange={(v) => setBulkStatus(v as FindingStatus)} aria-label={tr('Status')}>
            {FINDING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {FINDING_STATUS[s]}
              </option>
            ))}
          </Select>
          <Input placeholder={tr('reason, one for all')} value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} />
          <IconButton icon="check" title={tr('Give the picked findings this status and reason, all or none')} label={tr('Set status {n}', { n: chosenAny.length })} onClick={() => void setStatus()} />
        </div>
      )}
      {estimate && <EstimatePanel estimate={estimate} title={estimateFix ? tr('fix check') : tr('independent verification')} batchSetting="findings.verify_estimate_tokens" perFinding onRun={() => void start()} onCancel={() => setEstimate(null)} />}
      <Table>
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {tr('No findings: they come from matrix verdicts, SCA and manual input')}
            </EmptyRow>
          )}
          {g.rows.map((f) => (
            <tr key={f.id} className={selection?.kind === 'finding' && selection.id === f.id ? 'selected' : f.mergedInto ? 'removed' : ''} onClick={() => onSelect({ kind: 'finding', id: f.id })}>
              <td onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  aria-label={tr('Pick')}
                  disabled={!pickable(f)}
                  checked={picked.includes(f.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, f.id] : picked.filter((id) => id !== f.id))}
                />
              </td>
              <td>
                <strong>{f.title}</strong>
                {f.entryPoint && <div className="mono small muted">{f.entryPoint}</div>}
                {f.mergedInto && <div className="muted small">{tr('merged')}</div>}
              </td>
              <td>
                <span className={`status sev-${f.severity}`}>{SEVERITY[f.severity]}</span>
              </td>
              <td>
                <span className={`status fs-${f.status}`}>{FINDING_STATUS[f.status]}</span>
              </td>
              <td>{f.verification && <span className={`status fv-${f.verification}`}>{FINDING_VERIFY_OUTCOME[f.verification]}</span>}</td>
              <td>
                {stale(f) && <span className="status stale">{tr('stale|map')}</span>}
                {fixStates[f.id]?.last && <span className={`status fx-${fixStates[f.id].last}`}>{FIX_OUTCOME[fixStates[f.id].last!]}</span>}
              </td>
              <td className="mono">{f.cwe ?? ''}</td>
              <td>{moduleName(f.moduleId)}</td>
              <td>{documents(f)}</td>
              <td className="small">
                {f.cells.length > 0 && <div>{tr('cells {n}', { n: f.cells.length })}</div>}
                {f.scaItems.length > 0 && <div>SCA {f.scaItems.length}</div>}
              </td>
              <td className="small">
                {time(f.createdAt)}
                <div className="muted">{f.author}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {g.pager}
    </div>
  );
}
