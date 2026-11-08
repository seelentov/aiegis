import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppEvent, ProjectInfo, QueueState, RecheckOffer, SearchHit, SearchKind, TerminalInfo } from '../shared/types';
import { api, bridge, errorText } from './api';
import { confirmFixVerify, confirmRecheck } from './components/AuditDetails';
import { DetailsPanel, type Selection } from './components/DetailsPanel';
import { DiffTab } from './components/DiffTab';
import { DocumentsTab } from './components/DocumentsTab';
import { EntryPointsTab } from './components/EntryPointsTab';
import { FindingsTab } from './components/FindingsTab';
import { moveRowSelection } from './components/Grid';
import { HomeTab } from './components/HomeTab';
import { MatrixTab } from './components/MatrixTab';
import { ModulesTab } from './components/ModulesTab';
import { QueueTab } from './components/QueueTab';
import { ScaTab } from './components/ScaTab';
import { SchedulesTab } from './components/SchedulesTab';
import { SearchPalette, type PaletteCommand } from './components/SearchPalette';
import { setAllSections } from './components/Section';
import { SessionList, SessionView, loadSessions, terminalOf, type FreeSession } from './components/SessionsTab';
import { SettingsTab } from './components/SettingsTab';
import { SignalsTab } from './components/SignalsTab';
import { Icon, type IconName } from './components/Icon';
import { Splitter, usePersisted } from './components/Splitter';
import { confirmClose, TerminalPanel, type TerminalPosition } from './components/TerminalPanel';
import { locale, tr } from './i18n';
import { cmdKey, copyText, MAC, MOD, ProjectIdContext, showMenu } from './menu';
import { reveal } from './reveal';
import { Button, IconButton, Select } from './ui';

// Groups read top to bottom: the audit itself, what it is built from, the machinery (pinned to the bottom of the activity bar).
const TABS = [
  { id: 'matrix', title: tr('Matrix'), icon: 'grid', stage: 3, group: 'audit' },
  { id: 'findings', title: tr('Findings'), icon: 'finding', stage: 3, group: 'audit' },
  { id: 'sca', title: 'SCA', icon: 'package', stage: 5, group: 'audit' },
  { id: 'signals', title: tr('Signals'), icon: 'scan', stage: 4, group: 'audit' },
  { id: 'entry-points', title: tr('Entry points'), icon: 'route', stage: 2, group: 'audit' },
  { id: 'diff', title: tr('Branch check'), icon: 'branch', stage: 3, group: 'audit' },
  { id: 'modules', title: tr('Modules'), icon: 'layers', stage: 2, group: 'sources' },
  { id: 'documents', title: tr('Documents'), icon: 'file', stage: 3, group: 'sources' },
  { id: 'sessions', title: tr('Sessions'), icon: 'terminal', stage: 1, group: 'system' },
  { id: 'queue', title: tr('Queue'), icon: 'list', stage: 1, group: 'system' },
  { id: 'schedules', title: tr('Schedules'), icon: 'clock', stage: 1, group: 'system' },
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
  diff: tr('requirement'),
  'doc-proposal': tr('proposal'),
  schedule: tr('schedule'),
};


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

/** Section of each kind search everywhere finds. */
const HIT_TAB: Record<SearchKind, TabId> = {
  finding: 'findings',
  signal: 'signals',
  suppression: 'signals',
  sca: 'sca',
  module: 'modules',
  document: 'documents',
  'doc-proposal': 'documents',
  matrix: 'matrix',
  'diff-check': 'diff',
  schedule: 'schedules',
  job: 'queue',
  session: 'sessions',
};

/** Kinds whose hit opens the details panel. */
const HIT_SELECTION: Partial<Record<SearchKind, Selection['kind']>> = {
  finding: 'finding',
  signal: 'signal',
  suppression: 'suppression',
  sca: 'sca',
  module: 'module',
  'doc-proposal': 'doc-proposal',
  schedule: 'schedule',
  job: 'job',
};

/** A place in the history of back/forward navigation. */
interface Place {
  tab: TabId;
  selection: Selection | null;
}
const samePlace = (a: Place, b: Place) => a.tab === b.tab && a.selection?.kind === b.selection?.kind && a.selection?.id === b.selection?.id;
const HISTORY = 50;
// Shift pressed twice within this time, with no other key between, opens search everywhere (as in IDEA).
const DOUBLE_SHIFT_MS = 350;

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
  const [termPos, setTermPos] = usePersisted<TerminalPosition>('terminalPosition', 'bottom');
  const [termW, setTermW] = usePersisted('terminalWidth', 560);
  const [palette, setPalette] = useState<string | null>(null);
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
  const [matrixDraft, setMatrixDraft] = useState<string | null>(null);
  const [onboarded, setOnboarded] = usePersisted('onboarded', false);
  // The setup guide: on the first launch with no projects (from choosing one) and after adding a project (without that step);
  // stays in the activity bar until closed.
  const [guide, setGuide] = useState<'first' | 'project' | null>(null);
  const [homeOpen, setHomeOpen] = useState(false);
  const [sessions, setSessions] = useState<FreeSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** Terminal of a just started session, selected once its run shows up in the list. */
  const [pendingTerminal, setPendingTerminal] = useState<string | null>(null);

  const go = (id: TabId) => {
    setHomeOpen(false);
    setTab(id);
  };

  // Back/forward over sections and selected entities, as in VS Code.
  const trail = useRef<{ list: Place[]; i: number }>({ list: [], i: -1 });
  useEffect(() => {
    const h = trail.current;
    const here = { tab, selection };
    if (h.list[h.i] && samePlace(h.list[h.i], here)) return;
    // Closing the details is not a step: the next selection replaces it.
    if (!selection && h.list[h.i]?.tab === tab) return;
    h.list = [...h.list.slice(0, h.i + 1), here].slice(-HISTORY);
    h.i = h.list.length - 1;
  }, [tab, selection]);
  const navigate = (d: 1 | -1) => {
    const h = trail.current;
    const p = h.list[h.i + d];
    if (!p) return;
    h.i += d;
    go(p.tab);
    setSelection(p.selection);
    if (p.selection) reveal(`${p.selection.kind}:${p.selection.id}`);
  };

  // Ctrl+Tab walks the sections most recently used first; the order updates when Ctrl is released.
  const mru = useRef<TabId[]>([tab]);
  const cycle = useRef<{ list: TabId[]; i: number } | null>(null);
  useEffect(() => {
    if (!cycle.current) mru.current = [tab, ...mru.current.filter((t) => t !== tab)];
  }, [tab]);

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

  // Latest state for the window listeners, which are installed once.
  const keys = useRef({ sidebarOpen, termCollapsed, palette, navigate, go });
  keys.current = { sidebarOpen, termCollapsed, palette, navigate, go };
  useEffect(() => {
    let lastShift = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      const t = e.target as HTMLElement;
      const inField = !!t.closest('input, textarea, select, [contenteditable="true"], [role="listbox"]');
      const inTerminal = !!t.closest('.terminal-panel, .terminal-view');
      if (e.key === 'Shift') {
        const now = Date.now();
        if (!e.repeat && now - lastShift < DOUBLE_SHIFT_MS && !inTerminal && !k.palette) (setPalette(''), (lastShift = 0));
        else if (!e.repeat) lastShift = now;
        return;
      }
      lastShift = 0;
      if (k.palette !== null) return;
      if (e.key === 'Escape' && !inField && !inTerminal) return setSelection(null);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !inField && !inTerminal) {
        if (moveRowSelection(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        cycle.current ??= { list: mru.current.slice(), i: 0 };
        const c = cycle.current;
        c.i = (c.i + (e.shiftKey ? c.list.length - 1 : 1)) % c.list.length;
        k.go(c.list[c.i]);
      } else if (MAC ? e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Minus' : e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // VS Code: Ctrl+- / Ctrl+Shift+- on macOS, Alt+←/→ elsewhere.
        k.navigate(MAC ? (e.shiftKey ? 1 : -1) : e.key === 'ArrowRight' ? 1 : -1);
      } else if (cmdKey(e) && !e.altKey && e.code === 'KeyP') {
        setPalette(e.shiftKey ? '>' : '');
      } else {
        // VS Code bindings; capture phase so the terminal does not swallow them.
        if (!cmdKey(e) || e.altKey || e.shiftKey) return;
        // The tenth tab is on the 0 key, as the digits are laid out.
        const n = e.key === '0' ? 10 : Number(e.key);
        if (n >= 1 && n <= TABS.length) k.go(TABS[n - 1].id);
        else if (e.code === 'KeyB') setSidebarOpen(!k.sidebarOpen);
        else if (e.code === 'KeyJ') setTermCollapsed(!k.termCollapsed);
        else return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Control' || !cycle.current) return;
      const c = cycle.current;
      cycle.current = null;
      mru.current = [c.list[c.i], ...mru.current.filter((x) => x !== c.list[c.i])];
    };
    // Mouse back/forward buttons.
    const onMouse = (e: MouseEvent) => (e.button === 3 || e.button === 4) && keys.current.navigate(e.button === 3 ? -1 : 1);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

  const refreshTerminals = useCallback(async () => setTerminals(await api.listTerminals()), []);

  useEffect(() => {
    void api.listProjects().then((ps) => {
      setProjects(ps);
      if (ps[0]) setProjectId((cur) => cur ?? ps[0].id);
      if (!onboarded) {
        if (!ps.length) (setGuide('first'), setHomeOpen(true));
        setOnboarded(true);
      }
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

  useEffect(() => {
    if (tab === 'sessions' && projectId) void run(loadSessions(projectId)).then((ss) => ss && setSessions(ss));
  }, [tab, projectId, revision, run]);

  useEffect(() => {
    const t = terminals.find((x) => x.id === pendingTerminal);
    const s = t && sessions.find((x) => x.runs.some((r) => r.id === t.runId));
    if (s) (setSessionId(s.sessionId), setPendingTerminal(null));
  }, [terminals, sessions, pendingTerminal]);

  const newSession = () => {
    if (!projectId) return;
    void run(api.newSession(projectId)).then((id) => {
      if (!id) return;
      setPendingTerminal(id);
      go('sessions');
      void refreshTerminals();
    });
  };

  const pickProject = (id: string) => {
    setProjectId(id);
    setSelection(null);
    setMapModule(null);
    setSessionId(null);
  };

  const addProject = async () => {
    const p = await run(api.pickAndAddProject());
    if (!p) return;
    setProjects(await api.listProjects());
    setProjectId(p.id);
    setGuide((g) => g ?? 'project');
    setHomeOpen(true);
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
    go('entry-points');
  }, []);

  const createMatrix = useCallback((documentId: string) => {
    setMatrixDraft(documentId);
    go('matrix');
  }, []);

  const openHit = (h: SearchHit, inEditor: boolean) => {
    if (inEditor && h.location) return void run(api.openInEditor(h.location.file, h.location.line ?? undefined, projectId ?? undefined));
    go(HIT_TAB[h.kind]);
    if (h.kind === 'session') return setSessionId(h.id);
    const kind = HIT_SELECTION[h.kind];
    setSelection(kind ? { kind, id: h.id } : null);
    reveal(`${h.kind}:${h.id}`);
  };

  const closeTerminals = (list: TerminalInfo[]) => {
    if (!list.length || !confirmClose(list)) return;
    for (const t of list) void run(api.terminalClose(t.id));
  };

  const commands = (): PaletteCommand[] => [
    ...TABS.map((t, i) => ({ id: `go.${t.id}`, title: tr('Go to: {section}', { section: t.title }), keys: i < 10 ? `${MOD}${(i + 1) % 10}` : undefined, run: () => go(t.id) })),
    { id: 'back', title: tr('Go back'), keys: MAC ? '⌃-' : 'Alt+←', run: () => navigate(-1) },
    { id: 'forward', title: tr('Go forward'), keys: MAC ? '⌃⇧-' : 'Alt+→', run: () => navigate(1) },
    ...(projectId ? [{ id: 'session.new', title: tr('New session'), run: newSession }] : []),
    { id: 'sidebar', title: tr('Toggle the session list'), keys: `${MOD}B`, run: () => setSidebarOpen(!sidebarOpen) },
    { id: 'terminal', title: tr('Toggle the terminal'), keys: `${MOD}J`, run: () => setTermCollapsed(!termCollapsed) },
    { id: 'terminal.max', title: termMax ? tr('Restore terminal size') : tr('Maximize terminal'), run: () => (setTermCollapsed(false), setTermMax(!termMax)) },
    {
      id: 'terminal.move',
      title: termPos === 'bottom' ? tr('Move the panel to the right') : tr('Move the panel to the bottom'),
      run: () => setTermPos(termPos === 'bottom' ? 'right' : 'bottom'),
    },
    { id: 'terminal.close-finished', title: tr('Terminal: close finished'), run: () => closeTerminals(terminals.filter((t) => !t.alive)) },
    { id: 'terminal.close-all', title: tr('Terminal: close all'), run: () => closeTerminals(terminals) },
    ...terminals.map((t) => ({ id: `terminal.${t.id}`, title: tr('Terminal: {title}', { title: t.title }), run: () => (setTermCollapsed(false), setActiveTerminal(t.id)) })),
    { id: 'sections.collapse', title: tr('Details: collapse all sections'), run: () => setAllSections(false) },
    { id: 'sections.expand', title: tr('Details: expand all sections'), run: () => setAllSections(true) },
    { id: 'notifications', title: tr('Show notifications'), run: () => (setCenterOpen(true), setUnread(0)) },
    { id: 'notifications.clear', title: tr('Clear notifications'), run: () => setHistory([]) },
    { id: 'project.add', title: tr('Add project'), run: () => void addProject() },
    ...projects.filter((p) => p.id !== projectId).map((p) => ({ id: `project.${p.id}`, title: tr('Switch project: {name}', { name: p.name }), run: () => pickProject(p.id) })),
  ];

  const detailsMenu = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('summary') || !selection) return;
    showMenu(e, [
      { label: tr('Collapse all sections'), run: () => setAllSections(false) },
      { label: tr('Expand all sections'), run: () => setAllSections(true) },
      null,
      { label: tr('Copy the id'), run: () => copyText(selection.id) },
      { label: tr('Close details'), run: () => setSelection(null) },
    ]);
  };

  const project = projects.find((p) => p.id === projectId) ?? null;
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const onSessions = tab === 'sessions' && !homeOpen;
  const details = !homeOpen && tab !== 'settings' && tab !== 'sessions' && selection !== null;
  const session = sessions.find((s) => s.sessionId === sessionId);
  const sessionTerminal = onSessions ? terminalOf(session, terminals) : undefined;
  const sidebar = sidebarOpen && onSessions && project !== null;

  const running = queue?.running ?? 0;
  const termOpen = !termCollapsed && terminals.length > 0;
  const activityItem = (t: (typeof TABS)[number], i: number) => (
    <Button
      key={t.id}
      className={`activity-item ${t.id === tab && !homeOpen ? 'active' : ''} ${i > 0 && TABS[i - 1].group !== t.group && t.group !== 'system' ? 'group-start' : ''}`}
      title={i < 10 ? `${t.title} (${MOD}${(i + 1) % 10})` : t.title}
      aria-label={t.title}
      aria-current={t.id === tab && !homeOpen ? 'page' : undefined}
      onClick={() => go(t.id)}
    >
      <Icon name={t.icon} size={22} />
      {t.id === 'queue' && running > 0 && <span className="activity-badge">{running}</span>}
    </Button>
  );

  return (
    <div className="app">
      <div className="shell" style={{ gridTemplateColumns: sidebar ? `auto ${sidebarW}px auto minmax(0, 1fr)` : 'auto minmax(0, 1fr)' }}>
        <nav className="activity-bar" aria-label={tr('Sections')}>
          {guide && (
            <Button className={`activity-item ${homeOpen ? 'active' : ''}`} title={tr('Setup guide')} aria-label={tr('Setup guide')} aria-current={homeOpen ? 'page' : undefined} onClick={() => setHomeOpen(true)}>
              <Icon name="home" size={22} />
            </Button>
          )}
          {TABS.map((t, i) => t.group !== 'system' && activityItem(t, i))}
          <span className="activity-spacer" />
          {TABS.map((t, i) => t.group === 'system' && activityItem(t, i))}
        </nav>

        {sidebar && (
          <>
            <aside className="sidebar" tabIndex={-1}>
              <SessionList
                projectId={project.id}
                sessions={sessions}
                active={sessionId}
                terminals={terminals}
                run={run}
                onSelect={setSessionId}
                onNew={newSession}
                onTerminal={showTerminal}
              />
            </aside>
            <Splitter axis="x" value={sidebarW} onChange={setSidebarW} min={180} max={480} reset={232} label={tr('Session list width')} />
          </>
        )}

        <main className={['main', termOpen && termMax && 'terminal-max', termPos === 'right' && 'terminal-right'].filter(Boolean).join(' ')}>
          <header className="crumbs">
            {project && (
              <div className="project-picker" title={project.root}>
                <Select value={project.id} onChange={pickProject} aria-label={tr('Project')}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <IconButton icon="folderPlus" variant="ghost" title={tr('Add git repository')} onClick={() => void addProject()} />
                <IconButton icon="trash" variant="ghost" title={tr('Remove the project from the list')} onClick={() => void removeProject(project)} />
              </div>
            )}
            <ol>
              {details ? (
                <li>
                  <Button className="crumb" onClick={() => setSelection(null)}>
                    {current.title}
                  </Button>
                </li>
              ) : (
                <li aria-current="location">{homeOpen ? tr('Setup guide') : current.title}</li>
              )}
              {details && selection && <li aria-current="location">{SELECTION_KIND[selection.kind]}</li>}
            </ol>
            {running > 0 && <div className="progress" role="progressbar" aria-label={tr('jobs running: {n}', { n: running })} />}
          </header>
          <div className="workspace" style={{ gridTemplateColumns: details ? `minmax(0, 1fr) auto ${detailsW}px` : 'minmax(0, 1fr)' }}>
            {/* Remount per project: tabs keep project-scoped ids (e.g. the selected matrix) in local state. */}
            <ProjectIdContext value={project?.id ?? null}>
            <section key={project?.id} className={onSessions && project ? 'content flush' : 'content'} tabIndex={-1}>
              {homeOpen ? (
                <HomeTab
                  project={project}
                  revision={revision}
                  run={run}
                  onAddProject={guide === 'first' ? () => void addProject() : undefined}
                  onOpen={go}
                  onCreateMatrix={createMatrix}
                  onTerminal={showTerminal}
                  onClose={() => (setGuide(null), setHomeOpen(false))}
                />
              ) : tab === 'settings' ? (
                <SettingsTab project={project} run={run} notify={notify} />
              ) : !project ? (
                <div className="empty">
                  <p>{tr('No projects.')}</p>
                  <IconButton icon="folderPlus" variant="primary" title={tr('Add git repository')} label={tr('Add project')} onClick={() => void addProject()} />
                </div>
              ) : tab === 'sessions' ? (
                <SessionView projectId={project.id} session={session} terminal={sessionTerminal} run={run} onTerminal={showTerminal} onNew={newSession} />
              ) : tab === 'queue' ? (
                <QueueTab
                  project={project}
                  revision={revision}
                  run={run}
                  selection={selection}
                  onSelect={setSelection}
                  onTerminal={showTerminal}
                />
              ) : tab === 'schedules' ? (
                <SchedulesTab project={project} revision={revision} run={run} selection={selection} onSelect={setSelection} />
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
                <DocumentsTab project={project} revision={revision} run={run} onTerminal={showTerminal} selection={selection} onSelect={setSelection} notify={notify} onCreateMatrix={createMatrix} />
              ) : tab === 'matrix' ? (
                <MatrixTab project={project} revision={revision} run={run} selection={selection} onSelect={setSelection} draftDocument={matrixDraft} onDraftTaken={() => setMatrixDraft(null)} />
              ) : tab === 'diff' ? (
                <DiffTab project={project} revision={revision} run={run} selection={selection} onSelect={setSelection} />
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
            </ProjectIdContext>
            {details && (
              <Splitter axis="x" invert value={detailsW} onChange={setDetailsW} min={300} max={900} reset={420} label={tr('Details panel width')} />
            )}
            {details && (
              <div className="details-wrap" tabIndex={-1} onContextMenu={detailsMenu}>
                <IconButton icon="close" variant="ghost" className="details-close" title={tr('Close details (Esc)')} onClick={() => setSelection(null)} />
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
            terminals={sessionTerminal ? terminals.filter((t) => t.id !== sessionTerminal.id) : terminals}
            active={activeTerminal}
            onActivate={setActiveTerminal}
            run={run}
            size={termPos === 'right' ? termW : termH}
            onSize={termPos === 'right' ? setTermW : setTermH}
            position={termPos}
            onPosition={setTermPos}
            onNewSession={project ? newSession : undefined}
            onShowRun={(id) => (go('queue'), setSelection({ kind: 'run', id }))}
            collapsed={termCollapsed}
            onCollapsed={setTermCollapsed}
            maximized={termMax}
            onMaximized={setTermMax}
          />
        </main>
      </div>

      <footer className="statusbar">
        <Button className="status-item" title={project ? project.root : tr('Add project')} onClick={() => (project ? go('sessions') : void addProject())}>
          <Icon name="folder" size={14} />
          <span>{project?.name ?? tr('no project')}</span>
        </Button>
        <Button className="status-item" title={tr('Open queue')} onClick={() => go('queue')}>
          {running > 0 ? (
            <span className="spin">
              <Icon name="recheck" size={14} />
            </span>
          ) : (
            <Icon name="list" size={14} />
          )}
          <span>{running > 0 ? tr('running {n} of {total}', { n: running, total: queue?.parallelism ?? running }) : tr('no jobs running')}</span>
          {queue?.pausedUntil && <span className="warn">{tr('paused until {time}', { time: new Date(queue.pausedUntil).toLocaleTimeString(locale) })}</span>}
        </Button>
        <Button className="status-item" title={`${termCollapsed ? tr('Show terminal') : tr('Hide terminal')} (${MOD}J)`} onClick={() => setTermCollapsed(!termCollapsed)}>
          <Icon name="terminal" size={14} />
          <span>{tr('sessions: {n}', { n: terminals.length })}</span>
        </Button>
        <Button
          className="status-item status-bell"
          title={unread > 0 ? tr('Notifications: {n} unread', { n: unread }) : tr('Notifications')}
          aria-pressed={centerOpen}
          onClick={() => (setCenterOpen(!centerOpen), setUnread(0))}
        >
          <Icon name="bell" size={14} />
          {unread > 0 && <span className="status-count">{unread}</span>}
        </Button>
      </footer>

      {centerOpen && (
        <section className="notice-center" aria-label={tr('Notifications')}>
          <div className="pane-header">
            <span>{tr('Notifications')}</span>
            <IconButton icon="trash" variant="ghost" title={tr('Clear')} disabled={history.length === 0} onClick={() => setHistory([])} />
            <IconButton icon="close" variant="ghost" title={tr('Close')} onClick={() => setCenterOpen(false)} />
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

      {palette !== null && (
        <SearchPalette projectId={projectId} initial={palette} commands={commands()} onOpen={openHit} onClose={() => setPalette(null)} />
      )}

      <div className="notices">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.level}`} onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>
            {n.text}
            {n.recheck && (
              <div className="row">
                {n.recheck.cells.length > 0 && (
                  <Button
                    variant="primary" className="btn-icon-label"
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
                  </Button>
                )}
                {n.recheck.findings.length > 0 && (
                  <Button
                    className="btn-icon-label"
                    onClick={(e) => {
                      e.stopPropagation();
                      const offer = n.recheck!;
                      const p = projects.find((x) => x.id === offer.projectId);
                      setNotices((x) => x.filter((y) => y.id !== n.id));
                      if (p) void confirmFixVerify(p, run, offer.findings);
                    }}
                  >
                    <Icon name="check" />
                    <span>{tr('Check fix ({n})', { n: n.recheck.findings.length })}</span>
                  </Button>
                )}
                <Button>{tr('Close')}</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export type RunFn = <T>(p: Promise<T>) => Promise<T | undefined>;
