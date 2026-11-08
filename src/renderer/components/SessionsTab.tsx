import type { Run, TerminalInfo } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { time } from '../format';
import { locale, tr } from '../i18n';
import { IconButton } from '../ui';
import { Icon } from './Icon';
import { TerminalView } from './TerminalPanel';

/** List titles drop the seconds: the session id tells same-minute sessions apart. */
const started = (iso: string) => new Date(iso).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** A free session: interactive runs outside jobs and entities that share one agent session id, newest run first. */
export interface FreeSession {
  sessionId: string;
  role: string;
  startedAt: string;
  runs: Run[];
}

// shortcut: only the newest runs are grouped, so very old sessions drop off the list; page it when that bites.
const SESSION_RUNS = 200;

export async function loadSessions(projectId: string): Promise<FreeSession[]> {
  const page = await api.pageRuns(projectId, { limit: SESSION_RUNS, sort: { key: 'started', dir: -1 }, filters: { kind: 'interactive' } });
  const byId = new Map<string, FreeSession>();
  for (const r of page.rows) {
    if (r.jobId || r.entityType) continue;
    const s = byId.get(r.sessionId);
    if (s) (s.runs.push(r), (s.startedAt = r.startedAt));
    else byId.set(r.sessionId, { sessionId: r.sessionId, role: r.role, startedAt: r.startedAt, runs: [r] });
  }
  return [...byId.values()];
}

/** The session's terminal: a live one first, else the tab left after it exited. */
export function terminalOf(session: FreeSession | undefined, terminals: TerminalInfo[]): TerminalInfo | undefined {
  if (!session) return undefined;
  const mine = terminals.filter((t) => t.mode === 'pty' && session.runs.some((r) => r.id === t.runId));
  return mine.find((t) => t.alive) ?? mine[mine.length - 1];
}

export function SessionList({ sessions, active, terminals, onSelect, onNew }: {
  sessions: FreeSession[];
  active: string | null;
  terminals: TerminalInfo[];
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      <div className="pane-header">
        <span>{tr('Sessions')}</span>
        <IconButton icon="plus" variant="ghost" title={tr('New session')} onClick={onNew} />
      </div>
      {sessions.length === 0 && <div className="muted small session-none">{tr('No sessions yet')}</div>}
      <ul className="project-list session-list">
        {sessions.map((s) => {
          const live = terminalOf(s, terminals)?.alive === true;
          return (
            <li key={s.sessionId} className={`${s.sessionId === active ? 'active' : ''} ${live ? 'live' : ''}`} onClick={() => onSelect(s.sessionId)}>
              <Icon name="terminal" size={14} />
              <span className="session-item">
                <span className="project-name">{started(s.startedAt)}</span>
                <span className="session-sub">
                  <span>{live ? tr('active|session') : tr('closed|session')}</span>
                  <span className="mono">{s.sessionId.slice(0, 8)}</span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function SessionView({ projectId, session, terminal, run, onTerminal, onNew }: {
  projectId: string;
  session: FreeSession | undefined;
  terminal: TerminalInfo | undefined;
  run: RunFn;
  onTerminal: (id: string | undefined) => void;
  onNew: () => void;
}) {
  if (!session)
    return (
      <div className="empty">
        <p>{tr('A free agent session in the project directory, with the aiegis tools.')}</p>
        <IconButton icon="terminal" variant="primary" title={tr('Interactive agent session')} label={tr('New session')} onClick={onNew} />
      </div>
    );
  const last = session.runs[0];
  const live = terminal?.alive === true;
  const resume = () => void run(api.openRun(projectId, last.id)).then(onTerminal);
  const stop = () => terminal && confirm(tr('Close the tab and terminate the claude process?')) && void run(api.terminalClose(terminal.id));
  return (
    <div className="session-view">
      <div className="session-head">
        <span className="session-title">{session.role}</span>
        <span className="muted mono" title={session.sessionId}>
          {session.sessionId.slice(0, 8)}
        </span>
        <span className="muted">{time(session.startedAt)}</span>
        <span className="muted session-cwd" title={last.cwd}>
          {last.cwd}
        </span>
        {live ? (
          <IconButton icon="stop" variant="ghost" title={tr('Stop the session')} onClick={stop} />
        ) : (
          <>
            <IconButton icon="external" variant="ghost" title={tr('Open in an external terminal')} onClick={() => void run(api.openExternal(projectId, last.id))} />
            <IconButton icon="play" variant="primary" title={tr('Resume the session in the terminal')} label={tr('Continue')} onClick={resume} />
          </>
        )}
      </div>
      {terminal ? (
        <div className="session-terminal">
          <TerminalView key={terminal.id} info={terminal} visible />
        </div>
      ) : (
        <div className="empty">{tr('The session is closed.')}</div>
      )}
    </div>
  );
}
