import { useEffect, useState } from 'react';
import type { Job, ProjectInfo, ResultRecord, Run } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { cost, JOB_STATUS, RUN_STATUS, time, tokens } from '../format';

export interface Selection {
  kind: 'job' | 'run';
  id: string;
}

interface Props {
  project: ProjectInfo | null;
  selection: Selection | null;
  revision: number;
  run: RunFn;
  onTerminal: (id: string | undefined) => void;
}

export function DetailsPanel({ project, selection, revision, run, onTerminal }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [details, setDetails] = useState<{ run: Run; results: ResultRecord[]; log: string | null } | null>(null);

  useEffect(() => {
    setJob(null);
    setDetails(null);
    if (!project || !selection) return;
    void (async () => {
      let runId: string | null = selection.id;
      if (selection.kind === 'job') {
        const j = (await api.listJobs(project.id)).find((x) => x.id === selection.id) ?? null;
        setJob(j);
        runId = j?.lastRunId ?? null;
      }
      if (runId) setDetails((await run(api.runDetails(project.id, runId))) ?? null);
    })();
  }, [project, selection, revision, run]);

  if (!project || !selection) return <aside className="details empty">Выберите задачу или прогон</aside>;

  const r = details?.run;
  return (
    <aside className="details">
      {job && (
        <section>
          <h3>Задача</h3>
          <dl>
            <dt>Название</dt>
            <dd>{job.title}</dd>
            <dt>Статус</dt>
            <dd>{JOB_STATUS[job.status]}</dd>
            {job.error && (
              <>
                <dt>Ошибка</dt>
                <dd className="error-text">{job.error}</dd>
              </>
            )}
            <dt>Коммит</dt>
            <dd className="mono">{String(job.payload.commit_sha ?? '').slice(0, 12)}</dd>
          </dl>
          <details>
            <summary>Промпт</summary>
            <pre>{String(job.payload.prompt ?? '')}</pre>
          </details>
        </section>
      )}
      {r && (
        <section>
          <h3>Прогон</h3>
          <dl>
            <dt>Статус</dt>
            <dd>{RUN_STATUS[r.status]}</dd>
            {r.error && (
              <>
                <dt>Ошибка</dt>
                <dd className="error-text">{r.error}</dd>
              </>
            )}
            <dt>Роль</dt>
            <dd>{r.role}</dd>
            <dt>Автор</dt>
            <dd>{r.author}</dd>
            <dt>Сессия</dt>
            <dd className="mono">{r.sessionId}</dd>
            <dt>Коммит</dt>
            <dd className="mono">{r.commitSha.slice(0, 12)}</dd>
            <dt>Каталог</dt>
            <dd className="mono small">{r.cwd}</dd>
            <dt>Время</dt>
            <dd>
              {time(r.startedAt)} → {time(r.finishedAt)}
            </dd>
            {r.kind === 'background' && (
              <>
                <dt>Токены</dt>
                <dd>
                  {tokens(r.usage)} (cache read {r.usage.cacheRead}) · {cost(r.usage)}
                </dd>
              </>
            )}
          </dl>
          <div className="actions">
            <button className="primary" onClick={() => void run(api.openRun(project.id, r.id)).then(onTerminal)}>
              Провалиться
            </button>
            <button onClick={() => void run(api.openExternal(project.id, r.id))}>Во внешнем терминале</button>
            {details?.log && <button onClick={() => void run(api.openInEditor(details.log!))}>Лог</button>}
          </div>
          <h4>Результаты</h4>
          {details.results.length === 0 ? (
            <div className="muted">нет</div>
          ) : (
            details.results.map((x) => (
              <div key={x.id} className="result">
                <div className="muted small">
                  {x.entityType}:{x.entityId.slice(0, 8)} · {x.author} · {time(x.createdAt)}
                </div>
                <pre>{String(x.data.summary ?? '')}</pre>
                {x.data.details ? <pre className="muted">{String(x.data.details)}</pre> : null}
              </div>
            ))
          )}
          <details>
            <summary>Итоговая конфигурация прогона</summary>
            <pre>{JSON.stringify(r.configSnapshot, null, 2)}</pre>
          </details>
        </section>
      )}
    </aside>
  );
}
