import { useEffect, useState } from 'react';
import { SCHEDULE_ACTIONS, type Matrix, type MatrixScope, type MatrixStage, type MatrixView, type ModuleSummary, type ProjectInfo, type ScaScope, type Schedule, type ScheduleAction, type ScheduleFiring, type ScheduleInput } from '../../shared/types';
import { api, errorText } from '../api';
import type { RunFn } from '../App';
import { SCHEDULE_ACTION, SCHEDULE_OUTCOME, time } from '../format';
import { tr } from '../i18n';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { IconButton } from './Icon';
import { Section } from './Section';

type Kind = ScheduleAction['kind'];
type Target = 'modules' | 'repository';

const PRESETS: { cron: string; title: string }[] = [
  { cron: '0 * * * *', title: tr('Every hour') },
  { cron: '0 3 * * *', title: tr('Every day at 03:00') },
  { cron: '0 3 * * 1', title: tr('Every Monday at 03:00') },
  { cron: '0 3 1 * *', title: tr('First day of the month at 03:00') },
];

const SCOPE_TITLE: Record<MatrixScope, string> = { pending: tr('not checked'), stale: tr('stale') };
const lines = (text: string) => text.split('\n').map((x) => x.trim()).filter(Boolean);

function ModuleChecks({ modules, chosen, onChange }: { modules: { id: string; name: string }[]; chosen: string[]; onChange: (x: string[]) => void }) {
  return (
    <fieldset className="wide">
      <legend>{tr('Modules (none selected means all)')}</legend>
      {modules.map((m) => (
        <label key={m.id} className="check">
          <input type="checkbox" checked={chosen.includes(m.id)} onChange={() => onChange(chosen.includes(m.id) ? chosen.filter((x) => x !== m.id) : [...chosen, m.id])} />
          {m.name}
        </label>
      ))}
    </fieldset>
  );
}

/** Create/edit form of a schedule; the core validates what is saved. */
export function ScheduleForm({ project, run, schedule, onDone }: { project: ProjectInfo; run: RunFn; schedule?: Schedule; onDone: (s?: Schedule) => void }) {
  const a = schedule?.action;
  const [name, setName] = useState(schedule?.name ?? '');
  const [cron, setCron] = useState(schedule?.cron ?? PRESETS[1].cron);
  const [preview, setPreview] = useState<{ next: string[]; timezone: string } | null>(null);
  const [cronError, setCronError] = useState('');
  const [kind, setKind] = useState<Kind>(a?.kind ?? 'matrix');
  const [maxTokens, setMaxTokens] = useState(schedule?.maxTokens?.toString() ?? '');
  const [prompt, setPrompt] = useState(a?.kind === 'task' ? a.prompt : '');
  const [role, setRole] = useState(a?.kind === 'task' ? a.role : '');
  const [title, setTitle] = useState(a?.kind === 'task' ? (a.title ?? '') : '');
  const [matrixId, setMatrixId] = useState(a?.kind === 'matrix' ? a.matrixId : '');
  const [stage, setStage] = useState<MatrixStage>(a?.kind === 'matrix' ? a.stage : 'verdicts');
  const [scope, setScope] = useState<MatrixScope>(a?.kind === 'matrix' ? a.scope : a?.kind === 'sca' ? (a.scope ?? 'pending') : 'pending');
  const [section, setSection] = useState(a?.kind === 'matrix' ? (a.slice?.section ?? '') : '');
  const [requirements, setRequirements] = useState(a?.kind === 'matrix' ? (a.slice?.requirements ?? []).join('\n') : '');
  const [cells, setCells] = useState(a?.kind === 'matrix' ? (a.slice?.cells ?? []).join('\n') : '');
  const [target, setTarget] = useState<Target>(a?.kind === 'scanners' && a.moduleIds === null ? 'repository' : 'modules');
  const [mods, setMods] = useState<string[]>(
    a?.kind === 'matrix' ? (a.slice?.modules ?? []) : a?.kind === 'scanners' || a?.kind === 'sca' || a?.kind === 'sca_inventory' ? (a.moduleIds ?? []) : a?.kind === 'entry_points' && a.moduleId ? [a.moduleId] : [],
  );
  const [matrices, setMatrices] = useState<Matrix[]>([]);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [roles, setRoles] = useState<{ name: string; title: string }[]>([]);
  const [view, setView] = useState<MatrixView | null>(null);

  useEffect(() => {
    void run(api.listMatrices(project.id)).then((ms) => {
      if (!ms) return;
      setMatrices(ms);
      setMatrixId((cur) => cur || (ms[0]?.id ?? ''));
    });
    void run(api.listModules(project.id)).then((ms) => ms && setModules(ms));
    void run(api.listRoles(project.id)).then((rs) => rs && setRoles(rs.filter((r) => r.kind === 'background')));
    void run(api.defaultTaskRole(project.id)).then((r) => r && setRole((cur) => cur || r));
  }, [project.id, run]);

  useEffect(() => {
    if (kind !== 'matrix' || !matrixId) return setView(null);
    void run(api.matrixView(project.id, matrixId)).then((v) => setView(v ?? null));
  }, [project.id, kind, matrixId, run]);

  useEffect(() => {
    let stale = false;
    // Waits for a pause in typing: half-typed expressions are not worth a call that fails.
    const timer = setTimeout(() => {
      api.cronPreview(project.id, cron).then(
        (p) => {
          if (stale) return;
          setPreview(p);
          setCronError('');
        },
        (e: unknown) => {
          if (stale) return;
          setPreview(null);
          setCronError(errorText(e));
        },
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [project.id, cron]);

  const action = (): ScheduleAction => {
    const moduleIds = mods.length ? mods : undefined;
    switch (kind) {
      case 'task':
        return { kind, prompt, role, title: title.trim() || undefined };
      case 'matrix': {
        const slice = {
          modules: moduleIds,
          requirements: lines(requirements).length ? lines(requirements) : undefined,
          section: section || undefined,
          cells: lines(cells).length ? lines(cells) : undefined,
        };
        return { kind, matrixId, stage, scope, slice: stage === 'verdicts' && Object.values(slice).some(Boolean) ? slice : undefined };
      }
      case 'scanners':
        return { kind, moduleIds: target === 'repository' ? null : mods };
      case 'sca_inventory':
        return { kind, moduleIds };
      case 'sca':
        return { kind, scope: scope as ScaScope, moduleIds };
      case 'entry_points':
        return { kind, moduleId: mods[0] };
    }
  };

  const limited = kind === 'matrix' || kind === 'sca';
  const save = async () => {
    const input: ScheduleInput = { name, cron, action: action(), maxTokens: limited && maxTokens.trim() ? Number(maxTokens) : null };
    const s = await run(schedule ? api.updateSchedule(project.id, schedule.id, input) : api.createSchedule(project.id, input));
    if (s) onDone(s);
  };
  const ready = name.trim() && !cronError && (kind === 'task' ? prompt.trim() && role : kind === 'matrix' ? matrixId : true);
  const sections = [...new Set((view?.requirements ?? []).map((r) => r.section || '—'))];

  return (
    <div className="form module-form">
      <label>
        {tr('Name')}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {tr('Preset')}
        <select value={PRESETS.some((p) => p.cron === cron) ? cron : ''} onChange={(e) => e.target.value && setCron(e.target.value)}>
          <option value="">{tr('Custom')}</option>
          {PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        {tr('Cron expression (minute hour day month weekday)')}
        <input className="mono" value={cron} onChange={(e) => setCron(e.target.value)} />
      </label>
      {cronError && <div className="warn small">{cronError}</div>}
      {preview && (
        <div className="muted small">
          {tr('Next, time zone {zone}:', { zone: preview.timezone })} {preview.next.map((n) => time(n)).join(' · ')}
        </div>
      )}
      <label>
        {tr('Action')}
        <select value={kind} onChange={(e) => (setKind(e.target.value as Kind), setMods([]))}>
          {SCHEDULE_ACTIONS.map((k) => (
            <option key={k} value={k}>
              {SCHEDULE_ACTION[k]}
            </option>
          ))}
        </select>
      </label>

      {kind === 'task' && (
        <>
          <label>
            {tr('Role')}
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.title} ({r.name})
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr('Title')}
            <input value={title} placeholder={tr('optional')} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="wide">
            {tr('Prompt')}
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
        </>
      )}

      {kind === 'matrix' && (
        <>
          <label>
            {tr('Matrix')}
            <select value={matrixId} onChange={(e) => (setMatrixId(e.target.value), setMods([]), setSection(''))}>
              {matrices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr('Stage')}
            <select value={stage} onChange={(e) => setStage(e.target.value as MatrixStage)}>
              <option value="verdicts">{tr('Verdicts')}</option>
              <option value="triage">{tr('n/a triage')}</option>
            </select>
          </label>
        </>
      )}

      {(kind === 'matrix' || kind === 'sca') && (
        <label>
          {kind === 'matrix' && stage === 'verdicts' ? tr('Cells of the whole matrix') : tr('Scope')}
          <select value={scope} onChange={(e) => setScope(e.target.value as MatrixScope)}>
            {(['pending', 'stale'] as const).map((x) => (
              <option key={x} value={x}>
                {SCOPE_TITLE[x]}
              </option>
            ))}
          </select>
        </label>
      )}

      {kind === 'matrix' && stage === 'verdicts' && (
        <details className="card wide" open={Boolean(mods.length || section || requirements || cells)}>
          <summary>{tr('Part of the matrix: only its unchecked and stale cells')}</summary>
          <div className="form module-form">
            <ModuleChecks modules={view?.modules ?? []} chosen={mods} onChange={setMods} />
            <label>
              {tr('Section')}
              <select value={section} onChange={(e) => setSection(e.target.value)}>
                <option value="">{tr('All')}</option>
                {sections.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr('Requirement keys (one per line)')}
              <textarea rows={2} value={requirements} onChange={(e) => setRequirements(e.target.value)} />
            </label>
            <label>
              {tr('Cell ids (one per line)')}
              <textarea rows={2} value={cells} onChange={(e) => setCells(e.target.value)} />
            </label>
          </div>
        </details>
      )}

      {kind === 'scanners' && (
        <label>
          {tr('Scan')}
          <select value={target} onChange={(e) => setTarget(e.target.value as Target)}>
            <option value="modules">{tr('Modules')}</option>
            <option value="repository">{tr('The whole repository')}</option>
          </select>
        </label>
      )}
      {((kind === 'scanners' && target === 'modules') || kind === 'sca' || kind === 'sca_inventory') && <ModuleChecks modules={modules} chosen={mods} onChange={setMods} />}
      {kind === 'entry_points' && (
        <label>
          {tr('Module')}
          <select value={mods[0] ?? ''} onChange={(e) => setMods(e.target.value ? [e.target.value] : [])}>
            <option value="">{tr('All')}</option>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {limited && (
        <label>
          {tr('Limit of estimated tokens per firing')}
          <input type="number" min={1} value={maxTokens} placeholder={tr('from the settings')} onChange={(e) => setMaxTokens(e.target.value)} />
        </label>
      )}

      <div className="wide row">
        <button className="primary" disabled={!ready} onClick={() => void save()}>
          {tr('Save')}
        </button>
        <button onClick={() => onDone()}>{tr('Cancel')}</button>
      </div>
    </div>
  );
}

function Outcome({ firing }: { firing: ScheduleFiring | null }) {
  if (!firing) return <span className="muted">—</span>;
  return (
    <span className={`status so-${firing.outcome}`} title={firing.reason ?? ''}>
      {SCHEDULE_OUTCOME[firing.outcome]}
    </span>
  );
}

/** Selected schedule in the details panel: its action, buttons and history. */
export function ScheduleDetailsView({ project, id, revision, run, onSelect }: { project: ProjectInfo; id: string; revision: number; run: RunFn; onSelect: (s: Selection | null) => void }) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [history, setHistory] = useState<ScheduleFiring[]>([]);
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState(new Map<string, string>());

  useEffect(() => setEditing(false), [id]);
  useEffect(() => {
    void Promise.all([api.listMatrices(project.id), api.listModules(project.id)]).then(([ms, mods]) => setNames(new Map([...ms, ...mods].map((x) => [x.id, x.name]))));
  }, [project.id, revision]);
  useEffect(() => {
    void run(api.scheduleDetails(project.id, id)).then((s) => setSchedule(s ?? null));
    void run(api.scheduleHistory(project.id, id, 50)).then((h) => h && setHistory(h));
  }, [project.id, id, revision, run]);

  if (!schedule) return <section />;
  const remove = async () => {
    if (!confirm(tr('Remove the schedule “{name}”? Its firings stay in the history.', { name: schedule.name }))) return;
    if (await run(api.removeSchedule(project.id, id).then(() => true))) onSelect(null);
  };

  return (
    <section>
      <h3>{tr('Schedule')} {schedule.name}</h3>
      {editing ? (
        <ScheduleForm project={project} run={run} schedule={schedule} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl>
            <dt>{tr('Cron')}</dt>
            <dd className="mono">{schedule.cron}</dd>
            <dt>{tr('Next')}</dt>
            <dd>{schedule.enabled ? time(schedule.nextAt) : tr('disabled')}</dd>
            <dt>{tr('Action')}</dt>
            <dd>{SCHEDULE_ACTION[schedule.action.kind]}</dd>
            <dt>{tr('Parameters')}</dt>
            <dd className="mono small">{JSON.stringify(schedule.action, (k, v: unknown) => (k === 'kind' ? undefined : typeof v === 'string' ? (names.get(v) ?? v) : v))}</dd>
            {(schedule.action.kind === 'matrix' || schedule.action.kind === 'sca') && (
              <>
                <dt>{tr('Token limit')}</dt>
                <dd>{schedule.maxTokens ?? tr('from the settings')}</dd>
              </>
            )}
          </dl>
          <div className="actions">
            <IconButton icon="play" className="primary" title={tr('Fire now, with the same checks as a planned firing')} label={tr('Run')} onClick={() => void run(api.runSchedule(project.id, id))} />
            <IconButton icon="edit" title={tr('Edit the schedule')} onClick={() => setEditing(true)} />
            <IconButton icon="trash" className="danger" title={tr('Remove the schedule')} onClick={() => void remove()} />
          </div>
        </>
      )}
      <Section title={tr('History')}>
        {history.length === 0 && <div className="muted">{tr('No firings yet')}</div>}
        {history.map((f) => (
          <div key={f.id} className="result">
            <div className="muted small">
              {time(f.firedAt)} · {f.trigger === 'manual' ? tr('manual') : tr('planned for {time}', { time: time(f.scheduledAt) })}
            </div>
            <Outcome firing={f} />
            {f.reason && <div className="small">{f.reason}</div>}
            {f.jobIds.map((j, i) => (
              <span key={j}>
                {' '}
                <a onClick={() => onSelect({ kind: 'job', id: j })}>{tr('job')} {i + 1}</a>
              </span>
            ))}
          </div>
        ))}
      </Section>
    </section>
  );
}

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}

export function SchedulesTab({ project, revision, run, selection, onSelect }: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void run(api.listSchedules(project.id)).then((s) => s && setSchedules(s));
  }, [project.id, revision, run]);

  const g = useGrid('schedules', schedules, [
    { key: 'name', title: tr('Name'), text: (s) => s.name },
    { key: 'cron', title: tr('Cron'), text: (s) => s.cron },
    { key: 'action', title: tr('Action'), text: (s) => SCHEDULE_ACTION[s.action.kind], filter: 'enum' },
    { key: 'next', title: tr('Next'), text: (s) => (s.enabled ? time(s.nextAt) : tr('disabled')), sort: (s) => s.nextAt ?? '' },
    { key: 'last', title: tr('Last firing'), text: (s) => (s.lastFiring ? SCHEDULE_OUTCOME[s.lastFiring.outcome] : '—'), filter: 'enum' },
    { key: 'actions', title: '', className: 'actions' },
  ]);

  return (
    <div className="schedules-tab">
      <div className="toolbar">
        <IconButton icon="plus" title={tr('Add a schedule')} label={tr('Schedule')} aria-pressed={creating} onClick={() => setCreating((c) => !c)} />
        <span className="muted">
          {tr('Schedules fire only while the app or the service is running · time zone {zone}', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
        </span>
      </div>

      {creating && (
        <div className="card">
          <strong>{tr('New schedule')}</strong>
          <ScheduleForm
            project={project}
            run={run}
            onDone={(s) => {
              setCreating(false);
              if (s) onSelect({ kind: 'schedule', id: s.id });
            }}
          />
        </div>
      )}

      {g.count && <div className="toolbar">{g.count}</div>}
      <table className="grid">
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {tr('No schedules')}
            </EmptyRow>
          )}
          {g.rows.map((s) => (
            <tr key={s.id} className={selection?.kind === 'schedule' && selection.id === s.id ? 'selected' : ''} onClick={() => onSelect({ kind: 'schedule', id: s.id })}>
              <td>
                <strong>{s.name}</strong>
              </td>
              <td className="mono small">{s.cron}</td>
              <td>{SCHEDULE_ACTION[s.action.kind]}</td>
              <td>{s.enabled ? time(s.nextAt) : <span className="muted">{tr('disabled')}</span>}</td>
              <td>
                <Outcome firing={s.lastFiring} /> {s.lastFiring && <span className="muted small">{time(s.lastFiring.firedAt)}</span>}
              </td>
              <td className="actions" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  title={s.enabled ? tr('Disable the schedule') : tr('Enable the schedule')}
                  aria-label={s.enabled ? tr('Disable the schedule') : tr('Enable the schedule')}
                  checked={s.enabled}
                  onChange={() => void run(s.enabled ? api.disableSchedule(project.id, s.id) : api.enableSchedule(project.id, s.id))}
                />
                <IconButton icon="play" title={tr('Fire now, with the same checks as a planned firing')} onClick={() => void run(api.runSchedule(project.id, s.id))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
