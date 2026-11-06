import { useEffect, useState } from 'react';
import type { Finding, MatrixEstimate, ModuleSummary, ProjectInfo } from '../../shared/types';
import { SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { FINDING_STATUS, FINDING_VERIFY_OUTCOME, SEVERITY, time } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { IconButton } from './Icon';
import { EstimatePanel } from './MatrixTab';
import { tr } from '../i18n';

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

  useEffect(() => {
    void run(api.listFindings(project.id)).then((f) => f && setFindings(f));
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
      { key: 'cwe', title: 'CWE', text: (f) => f.cwe ?? '' },
      { key: 'module', title: tr('Module'), text: (f) => moduleName(f.moduleId), filter: 'enum' },
      { key: 'document', title: tr('Document'), text: documents, filter: 'enum' },
      { key: 'links', title: tr('Links') },
      { key: 'created', title: tr('Created'), text: (f) => `${time(f.createdAt)} ${f.author}`, sort: (f) => f.createdAt },
    ],
  );

  const eligible = (f: Finding) => f.status === 'suspected' && !f.mergedInto;
  const chosen = findings.filter((f) => picked.includes(f.id) && eligible(f)).map((f) => f.id);
  const start = async () => {
    setEstimate(null);
    if (await run(api.runFindingVerify(project.id, chosen))) setPicked([]);
  };

  return (
    <div className="findings-tab">
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={merged} onChange={(e) => setMerged(e.target.checked)} /> {tr('show merged')}
        </label>
        <IconButton icon="check" title={tr('Pick the suspected findings shown below')} label={tr('Pick suspected')} onClick={() => setPicked(g.rows.filter(eligible).map((f) => f.id))} />
        <IconButton
          icon="play"
          title={tr('Estimate, then run a clean session per picked finding that tries to refute it')}
          label={tr('Verify {n}', { n: chosen.length })}
          disabled={!chosen.length}
          onClick={() => void run(api.estimateFindingVerify(project.id, chosen)).then((e) => e && setEstimate(e))}
        />
        {g.count}
      </div>
      {estimate && <EstimatePanel estimate={estimate} title={tr('independent verification')} batchSetting="findings.verify_estimate_tokens" perFinding onRun={() => void start()} onCancel={() => setEstimate(null)} />}
      <table className="grid">
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
                <input
                  type="checkbox"
                  aria-label={tr('Pick for verification')}
                  disabled={!eligible(f)}
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
      </table>
    </div>
  );
}
