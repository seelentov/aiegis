import { useEffect, useState } from 'react';
import type { Finding, FindingStatus, ModuleSummary, ProjectInfo } from '../../shared/types';
import { FINDING_STATUSES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { FINDING_STATUS, SEVERITY, time } from '../format';
import type { Selection } from './DetailsPanel';

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
  const [status, setStatus] = useState<FindingStatus | ''>('');
  const [merged, setMerged] = useState(false);

  useEffect(() => {
    void run(api.listFindings(project.id)).then((f) => f && setFindings(f));
    void api.listModules(project.id).then(setModules);
  }, [project.id, revision, run]);

  const shown = findings.filter((f) => (merged || !f.mergedInto) && (!status || f.status === status));
  const moduleName = (id: string | null) => modules.find((m) => m.id === id)?.name ?? '—';

  return (
    <div className="findings-tab">
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value as FindingStatus | '')}>
          <option value="">все статусы</option>
          {FINDING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {FINDING_STATUS[s]} ({findings.filter((f) => !f.mergedInto && f.status === s).length})
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={merged} onChange={(e) => setMerged(e.target.checked)} /> показывать объединённые
        </label>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Находка</th>
            <th>Severity</th>
            <th>Статус</th>
            <th>CWE</th>
            <th>Модуль</th>
            <th>Ячеек</th>
            <th>Создана</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Находок нет
              </td>
            </tr>
          )}
          {shown.map((f) => (
            <tr key={f.id} className={selection?.kind === 'finding' && selection.id === f.id ? 'selected' : f.mergedInto ? 'removed' : ''} onClick={() => onSelect({ kind: 'finding', id: f.id })}>
              <td>
                <strong>{f.title}</strong>
                {f.entryPoint && <div className="mono small muted">{f.entryPoint}</div>}
                {f.mergedInto && <div className="muted small">объединена</div>}
              </td>
              <td>
                <span className={`status sev-${f.severity}`}>{SEVERITY[f.severity]}</span>
              </td>
              <td>
                <span className={`status fs-${f.status}`}>{FINDING_STATUS[f.status]}</span>
              </td>
              <td className="mono">{f.cwe ?? ''}</td>
              <td>{moduleName(f.moduleId)}</td>
              <td>{f.cells.length}</td>
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
