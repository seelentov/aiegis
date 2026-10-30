import { useCallback, useEffect, useState } from 'react';
import type { AppEvent, ProjectInfo, QueueState, RecheckOffer, TerminalInfo } from '../shared/types';
import { api, bridge, errorText } from './api';
import { confirmRecheck } from './components/AuditDetails';
import { DetailsPanel, type Selection } from './components/DetailsPanel';
import { DocumentsTab } from './components/DocumentsTab';
import { EntryPointsTab } from './components/EntryPointsTab';
import { FindingsTab } from './components/FindingsTab';
import { MatrixTab } from './components/MatrixTab';
import { ModulesTab } from './components/ModulesTab';
import { QueueTab } from './components/QueueTab';
import { ScaTab } from './components/ScaTab';
import { SettingsTab } from './components/SettingsTab';
import { SignalsTab } from './components/SignalsTab';
import { Icon, IconButton, type IconName } from './components/Icon';
import { Splitter, usePersisted } from './components/Splitter';
import { TerminalPanel } from './components/TerminalPanel';
import { locale, tr } from './i18n';

// Groups read top to bottom: the audit itself, what it is built from, the machinery (pinned to the bottom of the activity bar).
const TABS = [
  { id: 'matrix', title: tr('Matrix'), icon: 'grid', stage: 3, group: 'audit' },
  { id: 'findings', title: tr('Findings'), icon: 'finding', stage: 3, group: 'audit' },
  { id: 'sca', title: 'SCA', icon: 'package', stage: 5, group: 'audit' },
  { id: 'signals', title: tr('Signals'), icon: 'scan', stage: 4, group: 'audit' },
  { id: 'entry-points', title: tr('Entry points'), icon: 'route', stage: 2, group: 'audit' },
  { id: 'modules', title: tr('Modules'), icon: 'layers', stage: 2, group: 'sources' },
  { id: 'documents', title: tr('Documents'), icon: 'file', stage: 3, group: 'sources' },
  { id: 'queue', title: tr('Queue'), icon: 'list', stage: 1, group: 'system' },
  { id: 'settings', title: tr('Settings'), icon: 'sliders', stage: 1, group: 'system' },
] as const satisfies readonly { id: string; title: string; icon: IconName; stage: number; group: string }[];

type TabId = (typeof TABS)[number]['id'];

const SELECTION_KIND: Record<Selection['kind'], string> = {
  job: tr('job'),
  run: tr('run'),
  module: tr('module'),
  cell: tr('cell'),
  finding: tr('finding'),
  signal: tr('signal'),
  suppression: tr('suppression'),
  sca: tr('vulnerability'),
};

const MAC = navigator.platform.startsWith('Mac');
const MOD = MAC ? '⌘' : 'Ctrl+';

interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
  /** Offer to re-check matrix cells; such notices stay until acted upon or dismissed. */
  recheck?: RecheckOffer & { projectId: string };
  at: number;
}

/** How many past notices the notification center keeps. */
const NOTICE_HISTORY = 50;

let noticeSeq = 0;

export function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = usePersisted<TabId>('tab', 'matrix');
  const [sidebarW, setSidebarW] = usePersisted('sidebarWidth', 232);
  const [sidebarOpen, setSidebarOpen] = usePersisted('sidebarOpen', true);
  const [detailsW, setDetailsW] = usePersisted('detailsWidth', 420);
  const [termH, setTermH] = usePersisted('terminalHeight', 320);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [termCollapsed, setTermCollapsed] = usePersisted('terminalCollapsed', false);
  const [termMax, setTermMax] = useState(false);
  const [history, setHistory] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [centerOpen, setCenterOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [revision, setRevision] = useState(0);
  const [mapModule, setMapModule] = useState<string | null>(null);

  const notify = useCallback((level: Notice['level'], text: string, recheck?: Notice['recheck']) => {
    const id = ++noticeSeq;
    const n0 = { id, level, text, recheck, at: Date.now() };
    setNotices((n) => [...n, n0]);
    setHistory((h) => [n0, ...h].slice(0, NOTICE_HISTORY));
    if (level !== 'info') setUnread((u) => u + 1);
    if (!recheck) setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), level === 'error' ? 12000 : 7000);
  }, []);

  /** Runs an API call, reporting errors as notices. */
  const run = useCallback(
    async <T,>(p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p;
      } catch (e) {
        notify('error', errorText(e));
        return undefined;
      }
    },
    [notify],
  );

  useEffect(() => {
    void api.queueState().then(setQueue);
  }, [revision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !t.closest('input, textarea, select, .terminal-panel')) return setSelection(null);
      // VS Code bindings; capture phase so the terminal does not swallow them.
      if (!(MAC ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1].id);
      else if (e.code === 'KeyB') setSidebarOpen(!sidebarOpen);
      else if (e.code === 'KeyJ') setTermCollapsed(!termCollapsed);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sidebarOpen, termCollapsed]);

  const refreshTerminals = useCallback(async () => setTerminals(await api.listTerminals()), []);

  useEffect(() => {
    void api.listProjects().then((ps) => {
      setProjects(ps);
      if (ps[0]) setProjectId((cur) => cur ?? ps[0].id);
    });
    void refreshTerminals();
    return bridge.onEvent((ev: AppEvent) => {
      if (ev.type === 'terminals-changed') void refreshTerminals();
      else if (ev.type === 'notice') notify(ev.level, ev.text, ev.recheck && ev.projectId ? { ...ev.recheck, projectId: ev.projectId } : undefined);
      else if (ev.type !== 'terminal-data') setRevision((r) => r + 1);
    });
  }, [notify, refreshTerminals]);

  const showTerminal = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      void refreshTerminals().then(() => setActiveTerminal(id));
    },
    [refreshTerminals],
  );

  const addProject = async () => {
    const p = await run(api.pickAndAddProject());
    if (!p) return;
    setProjects(await api.listProjects());
    setProjectId(p.id);
  };

  const removeProject = async (p: ProjectInfo) => {
    if (!confirm(tr('Remove project “{name}” from the list? Audit data stays on disk.', { name: p.name }))) return;
    await run(api.removeProject(p.id));
    const ps = await api.listProjects();
    setProjects(ps);
    setProjectId(ps[0]?.id ?? null);
  };

  const openMap = useCallback((moduleId: string) => {
    setMapModule(moduleId);
    setTab('entry-points');
  }, []);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const details = tab !== 'settings' && selection !== null;

  const running = queue?.running ?? 0;
  const termOpen = !termCollapsed && terminals.length > 0;
  const activityItem = (t: (typeof TABS)[number], i: number) => (
    <button
      key={t.id}
      className={`activity-item ${t.id === tab ? 'active' : ''} ${i > 0 && TABS[i - 1].group !== t.group && t.group !== 'system' ? 'group-start' : ''}`}
      title={`${t.title} (${MOD}${i + 1})`}
      aria-label={t.title}
      aria-current={t.id === tab ? 'page' : undefined}
      onClick={() => setTab(t.id)}
    >
      <Icon name={t.icon} size={22} />
      {t.id === 'queue' && running > 0 && <span className="activity-badge">{running}</span>}
    </button>
  );

  return (
    <div className="app">
      <div className="shell" style={{ gridTemplateColumns: sidebarOpen ? `auto ${sidebarW}px auto minmax(0, 1fr)` : 'auto minmax(0, 1fr)' }}>
        <nav className="activity-bar" aria-label={tr('Sections')}>
          <button
            className="activity-item projects-toggle"
            title={`${sidebarOpen ? tr('Hide projects') : tr('Show projects')} (${MOD}B)`}
            aria-label={tr('Projects')}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Icon name="folder" size={22} />
          </button>
          <span className="activity-rule" />
          {TABS.map((t, i) => t.group !== 'system' && activityItem(t, i))}
          <span className="activity-spacer" />
          {TABS.map((t, i) => t.group === 'system' && activityItem(t, i))}
        </nav>

        {sidebarOpen && (
          <>
            <aside className="sidebar" tabIndex={-1}>
              <div className="pane-header">
                <span>{tr('Projects')}</span>
                <IconButton icon="folderPlus" className="ghost" title={tr('Add git repository')} onClick={() => void addProject()} />
              </div>
              <ul className="project-list">
                {projects.map((p) => (
                  <li key={p.id} className={p.id === projectId ? 'active' : ''} onClick={() => (setProjectId(p.id), setSelection(null), setMapModule(null))}>
                    <span className="project-name" title={p.root}>
                      {p.name}
                    </span>
                    <IconButton icon="trash" className="ghost" title={tr('Remove from list')} onClick={(e) => (e.stopPropagation(), void removeProject(p))} />
                  </li>
                ))}
              </ul>
            </aside>
            <Splitter axis="x" value={sidebarW} onChange={setSidebarW} min={180} max={480} reset={232} label={tr('Project list width')} />
          </>
        )}

        <main className={termOpen && termMax ? 'main terminal-max' : 'main'}>
          <header className="crumbs">
            <ol>
              {project && (
                <li>
                  <button className="crumb" title={project.root} onClick={() => setSidebarOpen(true)}>
                    {project.name}
                  </button>
                </li>
              )}
              {details ? (
                <li>
                  <button className="crumb" onClick={() => setSelection(null)}>
                    {current.title}
                  </button>
                </li>
              ) : (
                <li aria-current="location">{current.title}</li>
              )}
              {details && selection && <li aria-current="location">{SELECTION_KIND[selection.kind]}</li>}
            </ol>
            {running > 0 && <div className="progress" role="progressbar" aria-label={tr('jobs running: {n}', { n: running })} />}
          </header>
          <div className="workspace" style={{ gridTemplateColumns: details ? `minmax(0, 1fr) auto ${detailsW}px` : 'minmax(0, 1fr)' }}>
            <section className="content" tabIndex={-1}>
              {tab === 'settings' ? (
                <SettingsTab project={project} run={run} notify={notify} />
              ) : !project ? (
                <div className="empty">
                  <p>{tr('No projects.')}</p>
                  <IconButton icon="folderPlus" className="primary" title={tr('Add git repository')} label={tr('Add project')} onClick={() => void addProject()} />
                </div>
              ) : tab === 'queue' ? (
                <QueueTab
                  project={project}
                  revision={revision}
                  run={run}
                  selection={selection}
                  onSelect={setSelection}
                  onTerminal={showTerminal}
                />
              ) : tab === 'modules' ? (
                <ModulesTab
                  project={project}
                  revision={revision}
                  run={run}
                  selection={selection}
                  onSelect={setSelection}
                  onOpenMap={openMap}
                  onTerminal={showTerminal}
                />
              ) : tab === 'documents' ? (
                <DocumentsTab project={project} revision={revision} run={run} onTerminal={showTerminal} />
              ) : tab === 'matrix' ? (
                <MatrixTab project={project} revision={revision} run={run} selection={selection} onSelect={setSelection} />
              ) : tab === 'findings' ? (
                <FindingsTab project={project} revision={revision} run={run} selection={selection} onSelect={setSelection} />
              ) : tab === 'sca' ? (
                <ScaTab project={project} revision={revision} run={run} selection={selection} onSelect={setSelection} notify={notify} />
              ) : tab === 'signals' ? (
                <SignalsTab project={project} revision={revision} run={run} selection={selection} onSelect={setSelection} notify={notify} />
              ) : tab === 'entry-points' ? (
                <EntryPointsTab
                  project={project}
                  revision={revision}
                  run={run}
                  moduleId={mapModule}
                  onModule={setMapModule}
                  onSelect={setSelection}
                />
              ) : (
                <div className="empty">{tr('Section “{title}” arrives at stage {stage}.', { title: current.title, stage: current.stage })}</div>
              )}
            </section>
            {details && (
              <Splitter axis="x" invert value={detailsW} onChange={setDetailsW} min={300} max={900} reset={420} label={tr('Details panel width')} />
            )}
            {details && (
              <div className="details-wrap" tabIndex={-1}>
                <IconButton icon="close" className="ghost details-close" title={tr('Close details (Esc)')} onClick={() => setSelection(null)} />
                <DetailsPanel
                  project={project}
                  selection={selection}
                  revision={revision}
                  run={run}
                  onTerminal={showTerminal}
                  onSelect={setSelection}
                  onOpenMap={openMap}
                />
              </div>
            )}
          </div>
          <TerminalPanel
            terminals={terminals}
            active={activeTerminal}
            onActivate={setActiveTerminal}
            run={run}
            height={termH}
            onHeight={setTermH}
            collapsed={termCollapsed}
            onCollapsed={setTermCollapsed}
            maximized={termMax}
            onMaximized={setTermMax}
          />
        </main>
      </div>

      <footer className="statusbar">
        <button className="status-item" title={project ? `${project.root} — ${sidebarOpen ? tr('hide projects') : tr('show projects')} (${MOD}B)` : tr('Add project')} onClick={() => (project ? setSidebarOpen(!sidebarOpen) : void addProject())}>
          <Icon name="folder" size={14} />
          <span>{project?.name ?? tr('no project')}</span>
        </button>
        <button className="status-item" title={tr('Open queue')} onClick={() => setTab('queue')}>
          {running > 0 ? (
            <span className="spin">
              <Icon name="recheck" size={14} />
            </span>
          ) : (
            <Icon name="list" size={14} />
          )}
          <span>{running > 0 ? tr('running {n} of {total}', { n: running, total: queue?.parallelism ?? running }) : tr('no jobs running')}</span>
          {queue?.pausedUntil && <span className="warn">{tr('paused until {time}', { time: new Date(queue.pausedUntil).toLocaleTimeString(locale) })}</span>}
        </button>
        <button className="status-item" title={`${termCollapsed ? tr('Show terminal') : tr('Hide terminal')} (${MOD}J)`} onClick={() => setTermCollapsed(!termCollapsed)}>
          <Icon name="terminal" size={14} />
          <span>{tr('sessions: {n}', { n: terminals.length })}</span>
        </button>
        <button
          className="status-item status-bell"
          title={unread > 0 ? tr('Notifications: {n} unread', { n: unread }) : tr('Notifications')}
          aria-pressed={centerOpen}
          onClick={() => (setCenterOpen(!centerOpen), setUnread(0))}
        >
          <Icon name="bell" size={14} />
          {unread > 0 && <span className="status-count">{unread}</span>}
        </button>
      </footer>

      {centerOpen && (
        <section className="notice-center" aria-label={tr('Notifications')}>
          <div className="pane-header">
            <span>{tr('Notifications')}</span>
            <IconButton icon="trash" className="ghost" title={tr('Clear')} disabled={history.length === 0} onClick={() => setHistory([])} />
            <IconButton icon="close" className="ghost" title={tr('Close')} onClick={() => setCenterOpen(false)} />
          </div>
          {history.length === 0 ? (
            <div className="empty">{tr('No notifications')}</div>
          ) : (
            <ul>
              {history.map((n) => (
                <li key={n.id} className={`notice-line ${n.level}`}>
                  <span className="muted small">{new Date(n.at).toLocaleTimeString(locale)}</span>
                  <div className="prewrap">{n.text}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="notices">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.level}`} onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>
            {n.text}
            {n.recheck && (
              <div className="row">
                <button
                  className="primary btn-icon-label"
                  onClick={(e) => {
                    e.stopPropagation();
                    const offer = n.recheck!;
                    const p = projects.find((x) => x.id === offer.projectId);
                    setNotices((x) => x.filter((y) => y.id !== n.id));
                    if (p) void confirmRecheck(p, run, offer.cells);
                  }}
                >
                  <Icon name="recheck" />
                  <span>{tr('Recheck ({n})', { n: n.recheck.cells.length })}</span>
                </button>
                <button>{tr('Close')}</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export type RunFn = <T>(p: Promise<T>) => Promise<T | undefined>;
