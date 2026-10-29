import { useCallback, useEffect, useState } from 'react';
import type { AppEvent, ProjectInfo, RecheckOffer, TerminalInfo } from '../shared/types';
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
import { Icon, IconButton } from './components/Icon';
import { Splitter, usePersisted } from './components/Splitter';
import { TerminalPanel } from './components/TerminalPanel';

// Groups read left to right: the audit itself, what it is built from, the machinery.
const TABS = [
  { id: 'matrix', title: 'Матрица', stage: 3, group: 'audit' },
  { id: 'findings', title: 'Находки', stage: 3, group: 'audit' },
  { id: 'sca', title: 'SCA', stage: 5, group: 'audit' },
  { id: 'signals', title: 'Сигналы', stage: 4, group: 'audit' },
  { id: 'entry-points', title: 'Точки входа', stage: 2, group: 'audit' },
  { id: 'modules', title: 'Модули', stage: 2, group: 'sources' },
  { id: 'documents', title: 'Документы', stage: 3, group: 'sources' },
  { id: 'queue', title: 'Очередь', stage: 1, group: 'system' },
  { id: 'settings', title: 'Настройки', stage: 1, group: 'system' },
] as const;

type TabId = (typeof TABS)[number]['id'];

interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
  /** Offer to re-check matrix cells; such notices stay until acted upon or dismissed. */
  recheck?: RecheckOffer & { projectId: string };
}

let noticeSeq = 0;

export function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = usePersisted<TabId>('tab', 'matrix');
  const [sidebarW, setSidebarW] = usePersisted('sidebarWidth', 232);
  const [sidebarOpen, setSidebarOpen] = usePersisted('sidebarOpen', true);
  const [detailsW, setDetailsW] = usePersisted('detailsWidth', 420);
  const [termH, setTermH] = usePersisted('terminalHeight', 320);
  const [running, setRunning] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [revision, setRevision] = useState(0);
  const [mapModule, setMapModule] = useState<string | null>(null);

  const notify = useCallback((level: Notice['level'], text: string, recheck?: Notice['recheck']) => {
    const id = ++noticeSeq;
    setNotices((n) => [...n, { id, level, text, recheck }]);
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
    void api.queueState().then((q) => setRunning(q.running));
  }, [revision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !t.closest('input, textarea, select, .terminal-panel')) setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    if (!confirm(`Удалить проект «${p.name}» из списка? Данные аудита останутся на диске.`)) return;
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

  return (
    <div className="app" style={{ gridTemplateColumns: sidebarOpen ? `${sidebarW}px auto minmax(0, 1fr)` : 'minmax(0, 1fr)' }}>
      {sidebarOpen && (
        <>
      <aside className="sidebar">
        <div className="brand">aiegis</div>
        <div className="section-title">Проекты</div>
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id} className={p.id === projectId ? 'active' : ''} onClick={() => (setProjectId(p.id), setSelection(null), setMapModule(null))}>
              <span className="project-name" title={p.root}>
                {p.name}
              </span>
              <IconButton icon="trash" className="ghost" title="Удалить из списка" onClick={(e) => (e.stopPropagation(), void removeProject(p))} />
            </li>
          ))}
        </ul>
        <IconButton icon="folderPlus" className="add-project" title="Добавить git-репозиторий" label="Добавить проект" onClick={() => void addProject()} />
      </aside>
      <Splitter axis="x" value={sidebarW} onChange={setSidebarW} min={180} max={480} reset={232} label="Ширина списка проектов" />
        </>
      )}

      <main className="main">
        <nav className="tabs">
          <IconButton
            icon="panelLeft"
            className={sidebarOpen ? 'ghost' : 'ghost off'}
            title={sidebarOpen ? 'Скрыть проекты' : 'Показать проекты'}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          />
          {!sidebarOpen && project && <span className="tabs-project">{project.name}</span>}
          {TABS.map((t, i) => (
            <button
              key={t.id}
              className={`tab ${t.id === tab ? 'active' : ''} ${i > 0 && TABS[i - 1].group !== t.group ? 'group-start' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.title}
              {t.id === 'queue' && running > 0 && (
                <span className="tab-count" title={`выполняется: ${running}`}>
                  {running}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="workspace" style={{ gridTemplateColumns: details ? `minmax(0, 1fr) auto ${detailsW}px` : 'minmax(0, 1fr)' }}>
          <section className="content">
            {tab === 'settings' ? (
              <SettingsTab project={project} run={run} notify={notify} />
            ) : !project ? (
              <div className="empty">Нет проектов. Добавьте git-репозиторий.</div>
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
              <div className="empty">Раздел «{current.title}» появится на этапе {current.stage}.</div>
            )}
          </section>
          {details && (
            <Splitter axis="x" invert value={detailsW} onChange={setDetailsW} min={300} max={900} reset={420} label="Ширина панели деталей" />
          )}
          {details && (
            <div className="details-wrap">
              <IconButton icon="close" className="ghost details-close" title="Закрыть детали (Esc)" onClick={() => setSelection(null)} />
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
        <TerminalPanel terminals={terminals} active={activeTerminal} onActivate={setActiveTerminal} run={run} height={termH} onHeight={setTermH} />
      </main>

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
                  <span>Перепроверить ({n.recheck.cells.length})</span>
                </button>
                <button>Закрыть</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export type RunFn = <T>(p: Promise<T>) => Promise<T | undefined>;
