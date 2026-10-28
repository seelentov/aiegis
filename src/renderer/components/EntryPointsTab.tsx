import { Fragment, useEffect, useState } from 'react';
import type { EntryPoint, EntryPointChange, EntryPointMap, EntryPointSnapshot, ModuleSummary, ProjectInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { time } from '../format';
import type { Selection } from './DetailsPanel';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  moduleId: string | null;
  onModule: (id: string) => void;
  onSelect: (s: Selection) => void;
}

const CHANGE: Record<EntryPointChange | 'removed', string> = { added: 'новая', changed: 'изменена', same: '', removed: 'удалена' };

const SNAPSHOT_STATUS: Record<EntryPointSnapshot['status'], string> = { building: 'строится', complete: '', failed: 'неполная' };

function snapshotLabel(s: EntryPointSnapshot): string {
  const st = SNAPSHOT_STATUS[s.status];
  return `${s.commitSha.slice(0, 8)} · ${time(s.createdAt)} · ${s.entryCount} точек${st ? ` · ${st}` : ''}`;
}

/** Expanded view of an entry point: middleware, parameters and call chain as a tree. */
function EntryTree({ e, open }: { e: EntryPoint; open: (file: string, line?: number) => void }) {
  return (
    <ul className="tree">
      <li>
        <span className="muted">Хэндлер</span>{' '}
        <a onClick={() => open(e.handler.file, e.handler.line)}>
          {e.handler.file}:{e.handler.line}
        </a>
      </li>
      <li>
        <span className="muted">Авторизация</span> {e.auth}
      </li>
      {e.middleware.length > 0 && (
        <li>
          <span className="muted">Middleware</span>
          <ul>
            {e.middleware.map((m, i) => (
              <li key={i} className="mono small">
                {m}
              </li>
            ))}
          </ul>
        </li>
      )}
      {e.params.length > 0 && (
        <li>
          <span className="muted">Параметры</span>
          <ul>
            {e.params.map((p, i) => (
              <li key={i}>
                <span className="mono">{p.name}</span> <span className="muted">← {p.source}</span>
                {p.type && <span className="muted"> : {p.type}</span>}
              </li>
            ))}
          </ul>
        </li>
      )}
      {e.callChain.length > 0 && (
        <li>
          <span className="muted">Цепочка вызовов</span>
          <ol className="chain">
            {e.callChain.map((c, i) => (
              <li key={i}>
                <a className="mono small" onClick={() => open(c.file, c.line)}>
                  {c.file}:{c.function}
                  {c.line ? `:${c.line}` : ''}
                </a>
                {c.sink && <span className="status sink">{c.sink}</span>}
              </li>
            ))}
          </ol>
        </li>
      )}
      {e.notes && (
        <li>
          <span className="muted">Заметки</span> {e.notes}
        </li>
      )}
    </ul>
  );
}

export function EntryPointsTab({ project, revision, run, moduleId, onModule, onSelect }: Props) {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [snapshotId, setSnapshotId] = useState<string | undefined>(undefined);
  const [map, setMap] = useState<EntryPointMap | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void run(api.listModules(project.id)).then((ms) => {
      if (!ms) return;
      setModules(ms);
      if (!moduleId || !ms.some((m) => m.id === moduleId)) {
        const first = ms.find((m) => m.latestSnapshot) ?? ms[0];
        if (first) onModule(first.id);
      }
    });
  }, [project.id, revision, run, moduleId, onModule]);

  useEffect(() => setSnapshotId(undefined), [moduleId]);

  useEffect(() => {
    if (!moduleId) return setMap(null);
    void run(api.entryPointMap(project.id, moduleId, snapshotId)).then((m) => setMap(m ?? null));
  }, [project.id, moduleId, snapshotId, revision, run]);

  const open = (file: string, line?: number) => void run(api.openInEditor(file, line, project.id));
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const q = filter.trim().toLowerCase();
  const match = (e: EntryPoint) => !q || [e.name, e.method ?? '', e.kind, e.handler.file, e.auth].some((x) => x.toLowerCase().includes(q));
  const snap = map?.snapshot;
  const counts = map && {
    added: map.entries.filter((e) => e.change === 'added').length,
    changed: map.entries.filter((e) => e.change === 'changed').length,
  };

  const row = (e: EntryPoint, change: EntryPointChange | 'removed') => (
    <Fragment key={e.id}>
      <tr className={change === 'removed' ? 'removed' : ''} onClick={() => toggle(e.id)}>
        <td>{expanded.has(e.id) ? '▾' : '▸'}</td>
        <td>{e.kind}</td>
        <td className="mono">{e.method ?? ''}</td>
        <td className="mono">{e.name}</td>
        <td className="mono small" onClick={(ev) => (ev.stopPropagation(), open(e.handler.file, e.handler.line))}>
          <a>
            {e.handler.file.split('/').pop()}:{e.handler.line}
          </a>
        </td>
        <td>{e.auth}</td>
        <td>{CHANGE[change] && <span className={`status c-${change}`}>{CHANGE[change]}</span>}</td>
      </tr>
      {expanded.has(e.id) && (
        <tr className="expanded">
          <td />
          <td colSpan={6}>
            <EntryTree e={e} open={open} />
          </td>
        </tr>
      )}
    </Fragment>
  );

  return (
    <div className="entry-points-tab">
      <div className="toolbar">
        <label>
          Модуль{' '}
          <select value={moduleId ?? ''} onChange={(e) => onModule(e.target.value)}>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {map && map.snapshots.length > 0 && (
          <label>
            Версия{' '}
            <select value={snap?.id ?? ''} onChange={(e) => setSnapshotId(e.target.value)}>
              {!snap && <option value="">—</option>}
              {map.snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {snapshotLabel(s)}
                </option>
              ))}
            </select>
          </label>
        )}
        <input placeholder="фильтр" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {moduleId && (
          <button onClick={() => void run(api.enqueueEntryPoints(project.id, moduleId))}>Построить заново</button>
        )}
      </div>

      {!modules.length ? (
        <div className="empty">Сначала разметьте модули на вкладке «Модули».</div>
      ) : !snap ? (
        <div className="empty">Карты точек входа для модуля ещё нет.</div>
      ) : (
        <>
          <div className="muted snapshot-info">
            Коммит <span className="mono">{snap.commitSha.slice(0, 12)}</span> ·{' '}
            <a onClick={() => onSelect({ kind: 'run', id: snap.runId })}>прогон</a>
            {map.baseline ? (
              <>
                {' '}
                · относительно <span className="mono">{map.baseline.commitSha.slice(0, 8)}</span>: +{counts!.added} ~{counts!.changed} −
                {map.removed.length}
              </>
            ) : (
              ' · первая версия'
            )}
            {snap.status !== 'complete' && <span className="warn"> · версия {SNAPSHOT_STATUS[snap.status]}</span>}
          </div>
          <table className="grid entry-grid">
            <thead>
              <tr>
                <th />
                <th>Тип</th>
                <th>Метод</th>
                <th>Маршрут / имя</th>
                <th>Хэндлер</th>
                <th>Авторизация</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {map.entries.filter(match).map((e) => row(e, e.change))}
              {map.removed.filter(match).map((e) => row(e, 'removed'))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
