import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import type { AppEvent, TerminalInfo } from '../../shared/types';
import { api, bridge } from '../api';
import type { RunFn } from '../App';
import { Icon } from './Icon';
import { Splitter } from './Splitter';
import { tr } from '../i18n';
import { cmdKey, copyText, FILE_LINE, MAC, showMenu } from '../menu';
import { IconButton, Input } from '../ui';

export type TerminalPosition = 'bottom' | 'right';

interface Props {
  terminals: TerminalInfo[];
  active: string | null;
  onActivate: (id: string | null) => void;
  run: RunFn;
  /** Height when at the bottom, width when on the right. */
  size: number;
  onSize: (s: number) => void;
  position: TerminalPosition;
  onPosition: (p: TerminalPosition) => void;
  collapsed: boolean;
  onCollapsed: (c: boolean) => void;
  /** The panel takes the whole work area. */
  maximized: boolean;
  onMaximized: (m: boolean) => void;
  onNewSession?: () => void;
  onShowRun: (runId: string) => void;
}

/** Asks once for a batch of tabs, naming how many live agent processes it would stop. */
export function confirmClose(tabs: TerminalInfo[]): boolean {
  const live = tabs.filter((t) => t.mode === 'pty' && t.alive).length;
  if (!live) return true;
  return confirm(tabs.length === 1 ? tr('Close the tab and terminate the claude process?') : tr('Close {n} tabs and terminate {live} agent processes?', { n: tabs.length, live }));
}

export function TerminalPanel(p: Props) {
  const { terminals, active, onActivate, run, collapsed, onCollapsed, maximized, onMaximized } = p;
  // Order and names are the renderer's own: dragging and renaming do not touch the sessions.
  const [order, setOrder] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);

  const pos = new Map(order.map((id, i) => [id, i]));
  const tabs = terminals
    .map((t, i) => ({ t, rank: pos.get(t.id) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.t);
  const current = tabs.find((t) => t.id === active) ?? tabs[tabs.length - 1] ?? null;

  useEffect(() => {
    if (active && terminals.some((t) => t.id === active)) onCollapsed(false);
  }, [active, terminals]);

  const closeMany = (list: TerminalInfo[]) => {
    if (!list.length || !confirmClose(list)) return;
    for (const t of list) void run(api.terminalClose(t.id));
    if (list.some((t) => t.id === current?.id)) onActivate(null);
  };

  const tabMenu = (e: React.MouseEvent, t: TerminalInfo) => {
    const i = tabs.indexOf(t);
    showMenu(e, [
      { label: tr('Close'), run: () => closeMany([t]) },
      { label: tr('Close others'), enabled: tabs.length > 1, run: () => closeMany(tabs.filter((x) => x !== t)) },
      { label: tr('Close to the left'), enabled: i > 0, run: () => closeMany(tabs.slice(0, i)) },
      { label: tr('Close to the right'), enabled: i < tabs.length - 1, run: () => closeMany(tabs.slice(i + 1)) },
      { label: tr('Close finished'), enabled: tabs.some((x) => !x.alive), run: () => closeMany(tabs.filter((x) => !x.alive)) },
      { label: tr('Close all'), run: () => closeMany(tabs) },
      null,
      { label: tr('Rename'), run: () => setRenaming(t.id) },
      { label: tr('Show the run'), run: () => p.onShowRun(t.runId) },
      t.mode === 'pty' && !t.alive && { label: tr('Open in an external terminal'), run: () => void run(api.openExternal(t.projectId, t.runId)) },
      { label: tr('Copy the run id'), run: () => copyText(t.runId) },
    ]);
  };

  const panelMenu = (e: React.MouseEvent) =>
    showMenu(e, [
      p.onNewSession && { label: tr('New session'), run: p.onNewSession },
      null,
      { label: tr('Close finished'), enabled: tabs.some((x) => !x.alive), run: () => closeMany(tabs.filter((x) => !x.alive)) },
      { label: tr('Close all'), enabled: tabs.length > 0, run: () => closeMany(tabs) },
      null,
      { label: maximized ? tr('Restore terminal size') : tr('Maximize terminal'), enabled: open, run: () => onMaximized(!maximized) },
      { label: collapsed ? tr('Show terminal') : tr('Hide terminal'), accelerator: 'CmdOrCtrl+J', enabled: tabs.length > 0, run: () => onCollapsed(!collapsed) },
      p.position === 'bottom'
        ? { label: tr('Move the panel to the right'), run: () => p.onPosition('right') }
        : { label: tr('Move the panel to the bottom'), run: () => p.onPosition('bottom') },
    ]);

  const drop = (target: string) => {
    if (!dragged || dragged === target) return;
    const ids = tabs.map((t) => t.id).filter((id) => id !== dragged);
    ids.splice(ids.indexOf(target), 0, dragged);
    setOrder(ids);
  };

  const open = !collapsed && terminals.length > 0;
  const max = open && maximized;
  const right = p.position === 'right';
  const limit = right ? window.innerWidth * 0.7 : window.innerHeight * 0.8;
  const cls = ['terminal-panel', right && 'right', max ? 'maximized' : !open && 'collapsed'].filter(Boolean).join(' ');
  return (
    <>
      {open && !max && (
        <Splitter
          axis={right ? 'x' : 'y'}
          invert
          value={p.size}
          onChange={p.onSize}
          min={right ? 280 : 120}
          max={Math.round(limit)}
          reset={right ? 560 : 320}
          label={right ? tr('Terminal width') : tr('Terminal height')}
          menu={[
            right
              ? { label: tr('Move the panel to the bottom'), run: () => p.onPosition('bottom') }
              : { label: tr('Move the panel to the right'), run: () => p.onPosition('right') },
          ]}
        />
      )}
      <section className={cls} style={open && !max ? (right ? { width: p.size } : { height: p.size }) : undefined}>
        <div className="terminal-tabs" onDoubleClick={(e) => open && e.target === e.currentTarget && onMaximized(!maximized)} onContextMenu={panelMenu}>
          <IconButton
            icon={collapsed ? 'chevronUp' : 'chevronDown'}
            variant="ghost"
            disabled={terminals.length === 0}
            title={collapsed ? tr('Show terminal (⌘J)') : tr('Hide terminal (⌘J)')}
            onClick={() => onCollapsed(!collapsed)}
          />
          <Icon name="terminal" />
          {terminals.length === 0 && <span className="muted small">{tr('No sessions: open one from Sessions or details')}</span>}
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`terminal-tab ${t.id === current?.id ? 'active' : ''} ${t.alive ? '' : 'dead'} ${t.id === dragged ? 'dragged' : ''}`}
              draggable={renaming !== t.id}
              onDragStart={(e) => (setDragged(t.id), (e.dataTransfer.effectAllowed = 'move'))}
              onDragOver={(e) => dragged && e.preventDefault()}
              onDrop={(e) => (e.preventDefault(), drop(t.id))}
              onDragEnd={() => setDragged(null)}
              onClick={() => (onActivate(t.id), onCollapsed(false))}
              // Middle click closes, as in VS Code; mousedown is cancelled so it does not start autoscroll.
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && closeMany([t])}
              onContextMenu={(e) => tabMenu(e, t)}
            >
              {t.mode === 'stream' && <Icon name="output" size={12} />}
              {renaming === t.id ? (
                <RenameInput
                  value={names[t.id] ?? t.title}
                  onDone={(v) => {
                    setRenaming(null);
                    if (v !== null) setNames((n) => ({ ...n, [t.id]: v.trim() || t.title }));
                  }}
                />
              ) : (
                <span title={t.mode === 'stream' ? tr('read-only') : tr('Double-click to rename')} onDoubleClick={() => setRenaming(t.id)}>
                  {names[t.id] ?? t.title}
                </span>
              )}
              <IconButton icon="close" variant="ghost" title={tr('Close tab')} onClick={(e) => (e.stopPropagation(), closeMany([t]))} />
            </div>
          ))}
          {open && (
            <IconButton
              icon={maximized ? 'minimize' : 'maximize'}
              variant="ghost"
              className="terminal-max"
              title={maximized ? tr('Restore terminal size') : tr('Maximize terminal (double-click the tab bar)')}
              aria-pressed={maximized}
              onClick={() => onMaximized(!maximized)}
            />
          )}
        </div>
        <div className="terminal-body">
          {tabs.map((t) => (
            <TerminalView key={t.id} info={t} visible={!collapsed && t.id === current?.id} />
          ))}
        </div>
      </section>
    </>
  );
}

/** Inline rename field: Enter or blur saves, Esc cancels (`null`). */
export function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <Input
      className="rename-input"
      autoFocus
      aria-label={tr('Name')}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v);
        else if (e.key === 'Escape') onDone(null);
      }}
    />
  );
}


export function TerminalView({ info, visible }: { info: TerminalInfo; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon; search: SearchAddon } | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12,
      convertEol: false,
      disableStdin: info.mode === 'stream',
      scrollback: 20000,
      // Hex of --color-term / --color-ink-2 / --color-accent: xterm does not parse oklch.
      theme: { background: '#06080b', foreground: '#c3c8cc', cursor: '#f7b83d', selectionBackground: '#f7b83d40' },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // The main process opens http(s) links in the browser.
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)));
    const links = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
        const found = [...text.matchAll(FILE_LINE)].map((m) => {
          const start = m.index + m[1].length;
          const end = m.index + m[0].length;
          return {
            range: { start: { x: start + 1, y }, end: { x: end, y } },
            text: m[0].slice(m[1].length),
            activate: () => void api.openInEditor(m[2], Number(m[3]), info.projectId),
          };
        });
        callback(found.length ? found : undefined);
      },
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !cmdKey(e) || e.altKey || e.shiftKey !== !MAC) return true;
      // VS Code: ⌘K clears, ⌘F finds (Ctrl+Shift+K / Ctrl+Shift+F elsewhere, so Ctrl+K and Ctrl+F still reach the shell).
      if (e.code === 'KeyK') term.clear();
      else if (e.code === 'KeyF') setFinding(true);
      else return true;
      e.preventDefault();
      return false;
    });
    term.open(ref.current!);
    termRef.current = { term, fit, search };

    // Events that arrive before the snapshot reply are already contained in it.
    let ready = false;
    const off = bridge.onEvent((ev: AppEvent) => {
      if (ready && ev.type === 'terminal-data' && ev.terminalId === info.id) term.write(ev.data);
    });
    void api.terminalSnapshot(info.id).then((snap) => {
      term.write(snap);
      ready = true;
    });
    const sub = info.mode === 'pty' ? term.onData((d) => void api.terminalWrite(info.id, d)) : null;
    const resize = term.onResize(({ cols, rows }) => info.mode === 'pty' && void api.terminalResize(info.id, cols, rows));
    const ro = new ResizeObserver(() => ref.current?.offsetParent && fit.fit());
    ro.observe(ref.current!);
    return () => {
      off();
      sub?.dispose();
      resize.dispose();
      links.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [info.id, info.mode]);

  useEffect(() => {
    if (!visible || !termRef.current) return;
    requestAnimationFrame(() => {
      termRef.current?.fit.fit();
      termRef.current?.term.focus();
    });
  }, [visible]);

  useEffect(() => {
    if (finding) findRef.current?.select();
  }, [finding]);

  const find = (back: boolean, incremental = false) => {
    const s = termRef.current?.search;
    if (!s || !query) return;
    if (back) s.findPrevious(query);
    else s.findNext(query, { incremental });
  };
  const closeFind = () => {
    setFinding(false);
    termRef.current?.search.clearDecorations();
    termRef.current?.term.focus();
  };

  const menu = (e: React.MouseEvent) => {
    const t = termRef.current?.term;
    if (!t) return;
    showMenu(e, [
      { label: tr('Copy'), enabled: t.hasSelection(), run: () => copyText(t.getSelection()) },
      info.mode === 'pty' && info.alive && { label: tr('Paste'), run: () => void navigator.clipboard.readText().then((x) => t.paste(x)) },
      { label: tr('Select all'), run: () => t.selectAll() },
      null,
      { label: tr('Find'), accelerator: MAC ? 'Cmd+F' : 'Ctrl+Shift+F', run: () => setFinding(true) },
      { label: tr('Clear'), accelerator: MAC ? 'Cmd+K' : 'Ctrl+Shift+K', run: () => t.clear() },
    ]);
  };

  return (
    <div className="terminal-view" style={{ display: visible ? 'block' : 'none' }} onContextMenu={menu}>
      <div ref={ref} className="terminal-host" />
      {finding && (
        <div className="terminal-find" role="search">
          <Input
            ref={findRef}
            type="search"
            aria-label={tr('Find in the terminal')}
            placeholder={tr('Find')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyUp={(e) => e.key.length === 1 && find(false, true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(e.shiftKey);
              else if (e.key === 'Escape') closeFind();
            }}
          />
          <IconButton icon="chevronUp" variant="ghost" title={tr('Previous match (Shift+Enter)')} onClick={() => find(true)} />
          <IconButton icon="chevronDown" variant="ghost" title={tr('Next match (Enter)')} onClick={() => find(false)} />
          <IconButton icon="close" variant="ghost" title={`${tr('Close')} (Esc)`} onClick={closeFind} />
        </div>
      )}
    </div>
  );
}
