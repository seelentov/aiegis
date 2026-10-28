import { useCallback, useEffect, useState } from 'react';
import type { AppEvent, ProjectInfo, TerminalInfo } from '../shared/types';
import { api, bridge, errorText } from './api';
import { DetailsPanel, type Selection } from './components/DetailsPanel';
import { EntryPointsTab } from './components/EntryPointsTab';
import { ModulesTab } from './components/ModulesTab';
import { QueueTab } from './components/QueueTab';
import { SettingsTab } from './components/SettingsTab';
import { TerminalPanel } from './components/TerminalPanel';

const TABS = [
  { id: 'matrix', title: 'Матрица', stage: 3 },
  { id: 'findings', title: 'Находки', stage: 3 },
  { id: 'sca', title: 'SCA', stage: 5 },
  { id: 'entry-points', title: 'Точки входа', stage: 2 },
  { id: 'signals', title: 'Сигналы', stage: 4 },
  { id: 'documents', title: 'Документы', stage: 3 },
  { id: 'modules', title: 'Модули', stage: 2 },
  { id: 'queue', title: 'Очередь/Сессии', stage: 1 },
  { id: 'settings', title: 'Настройки', stage: 1 },
] as const;

type TabId = (typeof TABS)[number]['id'];

interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

let noticeSeq = 0;

export function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('queue');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [revision, setRevision] = useState(0);
  const [mapModule, setMapModule] = useState<string | null>(null);

  const notify = useCallback((level: Notice['level'], text: string) => {
    const id = ++noticeSeq;
    setNotices((n) => [...n, { id, level, text }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), level === 'error' ? 12000 : 7000);
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

  const refreshTerminals = useCallback(async () => setTerminals(await api.listTerminals()), []);

  useEffect(() => {
    void api.listProjects().then((ps) => {
      setProjects(ps);
      if (ps[0]) setProjectId((cur) => cur ?? ps[0].id);
    });
    void refreshTerminals();
    return bridge.onEvent((ev: AppEvent) => {
      if (ev.type === 'terminals-changed') void refreshTerminals();
      else if (ev.type === 'notice') notify(ev.level, ev.text);
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
    if (!confirm(`Убрать проект «${p.name}» из списка? Данные аудита останутся на диске.`)) return;
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
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">aiegis</div>
        <div className="section-title">Проекты</div>
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id} className={p.id === projectId ? 'active' : ''} onClick={() => (setProjectId(p.id), setSelection(null), setMapModule(null))}>
              <span className="project-name" title={p.root}>
                {p.name}
              </span>
              <button className="icon" title="Убрать из списка" onClick={(e) => (e.stopPropagation(), void removeProject(p))}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <button className="add-project" onClick={() => void addProject()}>
          + Добавить проект
        </button>
      </aside>

      <main className="main">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.title}
            </button>
          ))}
        </nav>
        <div className={tab === 'settings' ? 'workspace no-details' : 'workspace'}>
          <section className="content">
            {tab === 'settings' ? (
              <SettingsTab project={project} run={run} notify={notify} />
            ) : !project ? (
              <div className="empty">Добавьте git-репозиторий, чтобы начать.</div>
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
          {tab !== 'settings' && (
            <DetailsPanel
              project={project}
              selection={selection}
              revision={revision}
              run={run}
              onTerminal={showTerminal}
              onSelect={setSelection}
              onOpenMap={openMap}
            />
          )}
        </div>
        <TerminalPanel terminals={terminals} active={activeTerminal} onActivate={setActiveTerminal} run={run} />
      </main>

      <div className="notices">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.level}`} onClick={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export type RunFn = <T>(p: Promise<T>) => Promise<T | undefined>;
