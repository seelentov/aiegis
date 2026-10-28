import { useEffect, useState } from 'react';
import type { Job, ProjectInfo, QueueState, Run } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { cost, JOB_STATUS, RUN_STATUS, time, tokens } from '../format';
import type { Selection } from './DetailsPanel';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onTerminal: (id: string | undefined) => void;
}

type Role = { name: string; title: string; kind: string };

export function QueueTab({ project, revision, run, selection, onSelect, onTerminal }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [role, setRole] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    void api.listJobs(project.id).then(setJobs);
    void api.listRuns(project.id).then(setRuns);
    void api.queueState().then(setQueue);
  }, [project.id, revision]);

  useEffect(() => {
    void run(api.listRoles(project.id)).then((rs) => rs && setRoles(rs.filter((r) => r.kind === 'background')));
    void run(api.defaultTaskRole(project.id)).then((r) => r && setRole(r));
  }, [project.id, run]);

  const enqueue = async () => {
    if (!prompt.trim()) return;
    const job = await run(api.enqueueTask(project.id, { prompt, role, title: title.trim() || undefined }));
    if (job) {
      setPrompt('');
      setTitle('');
    }
  };

  const sel = (kind: Selection['kind'], id: string) => selection?.kind === kind && selection.id === id;

  return (
    <div className="queue-tab">
      <div className="toolbar">
        <button className="primary" onClick={() => void run(api.newSession(project.id)).then(onTerminal)}>
          Новая сессия
        </button>
        {queue && (
          <span className="muted">
            Параллельность {queue.parallelism} · выполняется {queue.running}
            {queue.pausedUntil && (
              <>
                {' '}
                · <span className="warn">пауза (rate limit) до {new Date(queue.pausedUntil).toLocaleTimeString('ru-RU')}</span>{' '}
                <button onClick={() => void run(api.resumeQueue())}>Продолжить сейчас</button>
              </>
            )}
          </span>
        )}
      </div>

      <details className="card" open>
        <summary>Фоновая задача</summary>
        <div className="form">
          <label>
            Роль
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.title} ({r.name})
                </option>
              ))}
            </select>
          </label>
          <label>
            Название
            <input value={title} placeholder="необязательно" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="wide">
            Промпт
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <button className="primary" disabled={!prompt.trim() || !role} onClick={() => void enqueue()}>
            В очередь
          </button>
        </div>
      </details>

      <h3>Очередь</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Статус</th>
            <th>Задача</th>
            <th>Роль</th>
            <th>Создана</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Задач нет
              </td>
            </tr>
          )}
          {jobs.map((j) => (
            <tr key={j.id} className={sel('job', j.id) ? 'selected' : ''} onClick={() => onSelect({ kind: 'job', id: j.id })}>
              <td>
                <span className={`status s-${j.status}`}>{JOB_STATUS[j.status]}</span>
              </td>
              <td title={j.error ?? ''}>{j.title}</td>
              <td>{j.role}</td>
              <td>{time(j.createdAt)}</td>
              <td className="actions" onClick={(e) => e.stopPropagation()}>
                {j.status === 'running' && j.lastRunId && (
                  <>
                    <button onClick={() => void run(api.openRun(project.id, j.lastRunId!)).then(onTerminal)}>Поток</button>
                    <button onClick={() => void run(api.takeOver(project.id, j.id)).then(onTerminal)}>Перехватить</button>
                  </>
                )}
                {(j.status === 'queued' || j.status === 'running') && (
                  <button onClick={() => void run(api.cancelJob(project.id, j.id))}>Отменить</button>
                )}
                {(j.status === 'failed' || j.status === 'cancelled') && (
                  <button onClick={() => void run(api.retryJob(project.id, j.id))}>Повторить</button>
                )}
                {j.status !== 'running' && j.lastRunId && (
                  <button onClick={() => void run(api.openRun(project.id, j.lastRunId!)).then(onTerminal)}>Провалиться</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Сессии и прогоны</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Начало</th>
            <th>Тип</th>
            <th>Роль</th>
            <th>Статус</th>
            <th>Сессия</th>
            <th>Токены</th>
            <th>Стоимость</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Прогонов нет
              </td>
            </tr>
          )}
          {runs.map((r) => (
            <tr key={r.id} className={sel('run', r.id) ? 'selected' : ''} onClick={() => onSelect({ kind: 'run', id: r.id })}>
              <td>{time(r.startedAt)}</td>
              <td>{r.kind === 'background' ? 'фон' : 'интерактив'}</td>
              <td>{r.role}</td>
              <td>
                <span className={`status r-${r.status}`}>{RUN_STATUS[r.status]}</span>
              </td>
              <td className="mono">{r.sessionId.slice(0, 8)}</td>
              <td>{r.kind === 'background' ? tokens(r.usage) : '—'}</td>
              <td>{cost(r.usage)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
