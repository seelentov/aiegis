import { useEffect, useState } from 'react';
import type { Job, ProjectInfo, QueueState, Run, JobStatus, RunStatus } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { cost, JOB_STATUS, RUN_STATUS, time, tokens } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useServerGrid } from './Grid';
import { locale, tr } from '../i18n';
import { IconButton, Input, Select, Table, Textarea } from '../ui';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onTerminal: (id: string | undefined) => void;
}

type Role = { name: string; title: string; kind: string };

// Times are stored in UTC, and the service matches the stored text.
const DATE_FILTER = 'YYYY-MM-DD';

export function QueueTab({ project, revision, run, selection, onSelect, onTerminal }: Props) {
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [role, setRole] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
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
  const reload = `${project.id}/${revision}`;
  const jobGrid = useServerGrid<Job>('queue.jobs', [
    { key: 'status', title: tr('Status'), text: (j) => JOB_STATUS[j.status], filter: 'enum', label: (v) => JOB_STATUS[v as JobStatus] },
    { key: 'title', title: tr('Job'), text: (j) => j.title },
    { key: 'role', title: tr('Role'), text: (j) => j.role, filter: 'enum' },
    { key: 'created', title: tr('Created'), text: (j) => time(j.createdAt), placeholder: DATE_FILTER },
    { key: 'actions', title: '', className: 'actions' },
  ], (q) => run(api.pageJobs(project.id, q)), reload);
  const runGrid = useServerGrid<Run>('queue.runs', [
    { key: 'started', title: tr('Started'), text: (r) => time(r.startedAt), placeholder: DATE_FILTER },
    { key: 'kind', title: tr('Type'), text: (r) => (r.kind === 'background' ? tr('background') : tr('interactive')), filter: 'enum', label: (v) => (v === 'background' ? tr('background') : tr('interactive')) },
    { key: 'role', title: tr('Role'), text: (r) => r.role, filter: 'enum' },
    { key: 'status', title: tr('Status'), text: (r) => RUN_STATUS[r.status], filter: 'enum', label: (v) => RUN_STATUS[v as RunStatus] },
    { key: 'session', title: tr('Session'), text: (r) => r.sessionId },
    { key: 'tokens', title: tr('Tokens'), text: (r) => tokens(r.usage), filter: 'none' },
    { key: 'cost', title: tr('Cost'), text: (r) => cost(r.usage), filter: 'none' },
  ], (q) => run(api.pageRuns(project.id, q)), reload);

  return (
    <div className="queue-tab">
      <div className="toolbar">
        {queue && (
          <span className="muted">
            {tr('Parallelism {n} · running {running}', { n: queue.parallelism, running: queue.running })}
            {queue.pausedUntil && (
              <>
                {' '}
                · <span className="warn">{tr('paused (rate limit) until {time}', { time: new Date(queue.pausedUntil).toLocaleTimeString(locale) })}</span>{' '}
                <IconButton icon="play" title={tr('Resume')} label={tr('Continue')} onClick={() => void run(api.resumeQueue())} />
              </>
            )}
          </span>
        )}
      </div>

      <details className="card" open>
        <summary>{tr('Background task')}</summary>
        <div className="form">
          <label>
            {tr('Role')}
            <Select value={role} onChange={setRole}>
              {roles.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.title} ({r.name})
                </option>
              ))}
            </Select>
          </label>
          <label>
            {tr('Title')}
            <Input value={title} placeholder={tr('optional')} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="wide">
            {tr('Prompt')}
            <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <IconButton icon="plus" variant="primary" title={tr('Enqueue the job')} label={tr('Enqueue')} disabled={!prompt.trim() || !role} onClick={() => void enqueue()} />
        </div>
      </details>

      <div className="grid-title">
        <h3>{tr('Queue')}</h3>
        {jobGrid.count}
      </div>
      <Table>
        {jobGrid.head}
        <tbody>
          {jobGrid.rows.length === 0 && (
            <EmptyRow colSpan={jobGrid.colSpan} filtered={jobGrid.filtered}>
              {tr('No jobs')}
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
                    <IconButton icon="output" title={tr('Watch output')} onClick={() => void run(api.openRun(project.id, j.lastRunId!)).then(onTerminal)} />
                    <IconButton icon="takeover" title={tr('Take over into an interactive session')} onClick={() => void run(api.takeOver(project.id, j.id)).then(onTerminal)} />
                  </>
                )}
                {(j.status === 'queued' || j.status === 'running') && (
                  <IconButton icon="stop" variant="danger" title={tr('Cancel|action')} onClick={() => void run(api.cancelJob(project.id, j.id))} />
                )}
                {(j.status === 'failed' || j.status === 'cancelled') && (
                  <IconButton icon="retry" title={tr('Retry')} onClick={() => void run(api.retryJob(project.id, j.id))} />
                )}
                {j.status !== 'running' && j.lastRunId && (
                  <IconButton icon="terminal" title={tr('Open session')} onClick={() => void run(api.openRun(project.id, j.lastRunId!)).then(onTerminal)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {jobGrid.pager}

      <div className="grid-title">
        <h3>{tr('Sessions and runs')}</h3>
        {runGrid.count}
      </div>
      <Table>
        {runGrid.head}
        <tbody>
          {runGrid.rows.length === 0 && (
            <EmptyRow colSpan={runGrid.colSpan} filtered={runGrid.filtered}>
              {tr('No runs')}
            </EmptyRow>
          )}
          {runGrid.rows.map((r) => (
            <tr key={r.id} className={sel('run', r.id) ? 'selected' : ''} onClick={() => onSelect({ kind: 'run', id: r.id })}>
              <td>{time(r.startedAt)}</td>
              <td>{r.kind === 'background' ? tr('background') : tr('interactive')}</td>
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
      </Table>
      {runGrid.pager}
    </div>
  );
}
