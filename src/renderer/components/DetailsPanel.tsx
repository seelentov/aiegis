import { useEffect, useState } from 'react';
import type { EffectiveConfigView, Job, ModuleRevision, ModuleSummary, ProjectInfo, ResultRecord, Run } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { cost, JOB_STATUS, RUN_STATUS, time, tokens } from '../format';
import { CellDetailsView, FindingDetailsView } from './AuditDetails';
import { ConfigView } from './ConfigView';
import { ModuleForm } from './ModulesTab';
import { SignalDetailsView, SuppressionDetailsView } from './SignalDetails';

export interface Selection {
  kind: 'job' | 'run' | 'module' | 'cell' | 'finding' | 'signal' | 'suppression';
  id: string;
  /** Matrix the cell was opened from (its cascade level). */
  matrixId?: string;
}

interface Props {
  project: ProjectInfo | null;
  selection: Selection | null;
  revision: number;
  run: RunFn;
  onTerminal: (id: string | undefined) => void;
  onSelect: (s: Selection | null) => void;
  onOpenMap: (moduleId: string) => void;
}

function ModuleDetails({ project, id, revision, run, onSelect, onOpenMap }: Omit<Props, 'selection' | 'onTerminal' | 'project'> & { project: ProjectInfo; id: string }) {
  const [mod, setMod] = useState<ModuleSummary | null>(null);
  const [history, setHistory] = useState<ModuleRevision[]>([]);
  const [files, setFiles] = useState<number | null>(null);
  const [config, setConfig] = useState<EffectiveConfigView | null>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    setEditing(false);
    setReason('');
  }, [id]);

  useEffect(() => {
    void (async () => {
      const ms = await run(api.listModules(project.id));
      const m = ms?.find((x) => x.id === id) ?? null;
      setMod(m);
      setHistory((await run(api.moduleHistory(project.id, id))) ?? []);
      if (!m) return;
      setFiles((await api.previewGlobs(project.id, m.globs).catch(() => null))?.count ?? null);
      const role = await run(api.taskRole(project.id, 'entry_points'));
      setConfig(role ? ((await run(api.effectiveConfig(project.id, role, m.name))) ?? null) : null);
    })();
  }, [project.id, id, revision, run]);

  const remove = async () => {
    if (await run(api.removeModule(project.id, id, reason).then(() => true))) onSelect(null);
  };

  return (
    <section>
      <h3>Модуль {mod?.name ?? <span className="muted">(удалён)</span>}</h3>
      {mod && !editing && (
        <>
          <dl>
            <dt>Описание</dt>
            <dd>{mod.description || '—'}</dd>
            <dt>Globs</dt>
            <dd className="mono small">
              {mod.globs.map((g) => (
                <div key={g}>{g}</div>
              ))}
            </dd>
            <dt>Файлов</dt>
            <dd>{files ?? '—'} (в рабочей копии)</dd>
            <dt>Изменён</dt>
            <dd>
              {mod.author} · {time(mod.updatedAt)}
            </dd>
            <dt>Карта</dt>
            <dd>
              {mod.latestSnapshot
                ? `${mod.latestSnapshot.entryCount} точек · ${mod.latestSnapshot.commitSha.slice(0, 8)}`
                : 'нет'}
            </dd>
          </dl>
          <div className="actions">
            <button className="primary" disabled={Boolean(mod.activeJob)} onClick={() => void run(api.enqueueEntryPoints(project.id, id))}>
              Построить карту
            </button>
            <button disabled={!mod.latestSnapshot} onClick={() => onOpenMap(id)}>
              Открыть карту
            </button>
            <button onClick={() => setEditing(true)}>Изменить</button>
          </div>
          <div className="actions">
            <input placeholder="причина удаления" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button disabled={!reason.trim()} onClick={() => void remove()}>
              Удалить
            </button>
          </div>
        </>
      )}
      {mod && editing && <ModuleForm project={project} run={run} module={mod} onDone={() => setEditing(false)} />}
      <h4>История</h4>
      {history.map((h) => (
        <div key={h.id} className="result">
          <div className="muted small">
            {time(h.createdAt)} · {h.author}
            {h.runId && (
              <>
                {' '}
                · <a onClick={() => onSelect({ kind: 'run', id: h.runId! })}>прогон</a>
              </>
            )}
          </div>
          {h.deleted ? (
            <div className="warn">удалён: {h.reason}</div>
          ) : (
            <>
              <div>
                <strong>{h.name}</strong> — {h.description}
              </div>
              <div className="mono small">{h.globs.join(' ')}</div>
            </>
          )}
        </div>
      ))}
      {config && <ConfigView config={config} title="Итоговая конфигурация карты точек входа" />}
    </section>
  );
}

export function DetailsPanel({ project, selection, revision, run, onTerminal, onSelect, onOpenMap }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [details, setDetails] = useState<{ run: Run; results: ResultRecord[]; log: string | null } | null>(null);

  useEffect(() => {
    setJob(null);
    setDetails(null);
    if (!project || !selection || selection.kind !== 'job' && selection.kind !== 'run') return;
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

  if (!project || !selection) return <aside className="details empty">Выберите элемент списка</aside>;
  if (selection.kind === 'module')
    return (
      <aside className="details">
        <ModuleDetails project={project} id={selection.id} revision={revision} run={run} onSelect={onSelect} onOpenMap={onOpenMap} />
      </aside>
    );

  if (selection.kind === 'signal' || selection.kind === 'suppression') {
    const common = { project, revision, run, onSelect };
    return (
      <aside className="details">
        {selection.kind === 'signal' ? <SignalDetailsView {...common} id={selection.id} /> : <SuppressionDetailsView {...common} id={selection.id} />}
      </aside>
    );
  }

  if (selection.kind === 'cell' || selection.kind === 'finding') {
    const common = { project, revision, run, onSelect, onTerminal };
    return (
      <aside className="details">
        {selection.kind === 'cell' ? (
          <CellDetailsView {...common} id={selection.id} matrixId={selection.matrixId} />
        ) : (
          <FindingDetailsView {...common} id={selection.id} />
        )}
      </aside>
    );
  }

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
