import { useEffect, useState } from 'react';
import type { Finding, ModuleSummary, ProjectInfo } from '../../shared/types';
import { SEVERITIES } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { FINDING_STATUS, SEVERITY, time } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';

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
  const [merged, setMerged] = useState(false);

  useEffect(() => {
    void run(api.listFindings(project.id)).then((f) => f && setFindings(f));
    void api.listModules(project.id).then(setModules);
  }, [project.id, revision, run]);

  const moduleName = (id: string | null) => modules.find((m) => m.id === id)?.name ?? '—';
  const g = useGrid(
    'findings',
    findings.filter((f) => merged || !f.mergedInto),
    [
      { key: 'title', title: 'Находка', text: (f) => `${f.title} ${f.entryPoint ?? ''}` , sort: (f) => f.title },
      { key: 'severity', title: 'Severity', text: (f) => SEVERITY[f.severity], sort: (f) => SEVERITIES.indexOf(f.severity), filter: 'enum' },
      { key: 'status', title: 'Статус', text: (f) => FINDING_STATUS[f.status], filter: 'enum' },
      { key: 'cwe', title: 'CWE', text: (f) => f.cwe ?? '' },
      { key: 'module', title: 'Модуль', text: (f) => moduleName(f.moduleId), filter: 'enum' },
      { key: 'links', title: 'Связи' },
      { key: 'created', title: 'Создана', text: (f) => `${time(f.createdAt)} ${f.author}`, sort: (f) => f.createdAt },
    ],
  );

  return (
    <div className="findings-tab">
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={merged} onChange={(e) => setMerged(e.target.checked)} /> показывать объединённые
        </label>
        {g.count}
      </div>
      <table className="grid">
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              Находок нет: они появляются из вердиктов матрицы, SCA и ручного ввода
            </EmptyRow>
          )}
          {g.rows.map((f) => (
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
              <td className="small">
                {f.cells.length > 0 && <div>ячеек {f.cells.length}</div>}
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
