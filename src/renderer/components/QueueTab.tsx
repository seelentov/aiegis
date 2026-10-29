import { useEffect, useState } from 'react';
import type { Job, ProjectInfo, QueueState, Run } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { cost, JOB_STATUS, RUN_STATUS, time, tokens } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { IconButton } from './Icon';

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
  const jobGrid = useGrid('queue.jobs', jobs, [
    { key: 'status', title: 'Статус', text: (j) => JOB_STATUS[j.status], filter: 'enum' },
    { key: 'title', title: 'Задача', text: (j) => j.title },
    { key: 'role', title: 'Роль', text: (j) => j.role, filter: 'enum' },
    { key: 'created', title: 'Создана', text: (j) => time(j.createdAt), sort: (j) => j.createdAt },
    { key: 'actions', title: '', className: 'actions' },
  ]);
  const runGrid = useGrid('queue.runs', runs, [
    { key: 'started', title: 'Начало', text: (r) => time(r.startedAt), sort: (r) => r.startedAt },
    { key: 'kind', title: 'Тип', text: (r) => (r.kind === 'background' ? 'фон' : 'интерактив'), filter: 'enum' },
    { key: 'role', title: 'Роль', text: (r) => r.role, filter: 'enum' },
    { key: 'status', title: 'Статус', text: (r) => RUN_STATUS[r.status], filter: 'enum' },
    { key: 'session', title: 'Сессия', text: (r) => r.sessionId },
    { key: 'tokens', title: 'Токены', text: (r) => (r.kind === 'background' ? tokens(r.usage) : '—'), sort: (r) => r.usage.input + r.usage.cacheCreation + r.usage.output },
    { key: 'cost', title: 'Стоимость', text: (r) => cost(r.usage), sort: (r) => r.usage.costUsd ?? 0 },
  ]);

  return (
    <div className="queue-tab">
      <div className="toolbar">
        <IconButton
          icon="terminal"
          className="primary"
          title="Интерактивная сессия claude в терминале"
          label="Новая сессия"
          onClick={() => void run(api.newSession(project.id)).then(onTerminal)}
        />
        {queue && (
          <span className="muted">
            Параллельность {queue.parallelism} · выполняется {queue.running}
            {queue.pausedUntil && (
              <>
                {' '}
                · <span className="warn">пауза (rate limit) до {new Date(queue.pausedUntil).toLocaleTimeString('ru-RU')}</span>{' '}
                <IconButton icon="play" title="Снять паузу" label="Продолжить" onClick={() => void run(api.resumeQueue())} />
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
          <IconButton icon="plus" className="primary" title="Поставить задачу в очередь" label="В очередь" disabled={!prompt.trim() || !role} onClick={() => void enqueue()} />
        </div>
      </details>

      <div className="grid-title">
        <h3>Очередь</h3>
        {jobGrid.count}
      </div>
      <table className="grid">
        {jobGrid.head}
        <tbody>
          {jobGrid.rows.length === 0 && (
            <EmptyRow colSpan={jobGrid.colSpan} filtered={jobGrid.filtered}>
              Задач нет
            </EmptyRow>
          )}
          {jobGrid.rows.map((j) => (
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
                    <IconButton icon="output" title="Смотреть вывод" onClick={() => void run(api.openRun(project.id, j.lastRunId!)).then(onTerminal)} />
                    <IconButton icon="takeover" title="Перехватить в интерактивную сессию" onClick={() => void run(api.takeOver(project.id, j.id)).then(onTerminal)} />
                  </>
                )}
                {(j.status === 'queued' || j.status === 'running') && (
                  <IconButton icon="stop" className="danger" title="Отменить" onClick={() => void run(api.cancelJob(project.id, j.id))} />
                )}
                {(j.status === 'failed' || j.status === 'cancelled') && (
                  <IconButton icon="retry" title="Повторить" onClick={() => void run(api.retryJob(project.id, j.id))} />
                )}
                {j.status !== 'running' && j.lastRunId && (
                  <IconButton icon="terminal" title="Открыть сессию" onClick={() => void run(api.openRun(project.id, j.lastRunId!)).then(onTerminal)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="grid-title">
        <h3>Сессии и прогоны</h3>
        {runGrid.count}
      </div>
      <table className="grid">
        {runGrid.head}
        <tbody>
          {runGrid.rows.length === 0 && (
            <EmptyRow colSpan={runGrid.colSpan} filtered={runGrid.filtered}>
              Прогонов нет
            </EmptyRow>
          )}
          {runGrid.rows.map((r) => (
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
