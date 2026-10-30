import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { AppEvent, TerminalInfo } from '../../shared/types';
import { api, bridge } from '../api';
import type { RunFn } from '../App';
import { Icon, IconButton } from './Icon';
import { Splitter } from './Splitter';
import { tr } from '../i18n';

interface Props {
  terminals: TerminalInfo[];
  active: string | null;
  onActivate: (id: string | null) => void;
  run: RunFn;
  height: number;
  onHeight: (h: number) => void;
  collapsed: boolean;
  onCollapsed: (c: boolean) => void;
  /** The panel takes the whole work area. */
  maximized: boolean;
  onMaximized: (m: boolean) => void;
}

export function TerminalPanel({ terminals, active, onActivate, run, height, onHeight, collapsed, onCollapsed, maximized, onMaximized }: Props) {
  const current = terminals.find((t) => t.id === active) ?? terminals[terminals.length - 1] ?? null;

  useEffect(() => {
    if (active && terminals.some((t) => t.id === active)) onCollapsed(false);
  }, [active, terminals]);

  const close = (t: TerminalInfo) => {
    if (t.mode === 'pty' && t.alive && !confirm(tr('Close the tab and terminate the claude process?'))) return;
    void run(api.terminalClose(t.id));
    if (t.id === active) onActivate(null);
  };

  const open = !collapsed && terminals.length > 0;
  const max = open && maximized;
  return (
    <>
      {open && !max && (
        <Splitter axis="y" invert value={height} onChange={onHeight} min={120} max={Math.round(window.innerHeight * 0.8)} reset={320} label={tr('Terminal height')} />
      )}
    <section className={max ? 'terminal-panel maximized' : open ? 'terminal-panel' : 'terminal-panel collapsed'} style={open && !max ? { height } : undefined}>
      <div className="terminal-tabs" onDoubleClick={(e) => open && e.target === e.currentTarget && onMaximized(!maximized)}>
        <IconButton
          icon={collapsed ? 'chevronUp' : 'chevronDown'}
          className="ghost"
          disabled={terminals.length === 0}
          title={collapsed ? tr('Show terminal (⌘J)') : tr('Hide terminal (⌘J)')}
          onClick={() => onCollapsed(!collapsed)}
        />
        <Icon name="terminal" />
        {terminals.length === 0 && <span className="muted small">{tr('No sessions: open one from the queue or details')}</span>}
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`terminal-tab ${t.id === current?.id ? 'active' : ''} ${t.alive ? '' : 'dead'}`}
            onClick={() => (onActivate(t.id), onCollapsed(false))}
          >
            {t.mode === 'stream' && <Icon name="output" size={12} />}
            <span title={t.mode === 'stream' ? tr('read-only') : undefined}>{t.title}</span>
            <IconButton icon="close" className="ghost" title={tr('Close tab')} onClick={(e) => (e.stopPropagation(), close(t))} />
          </div>
        ))}
        {open && (
          <IconButton
            icon={maximized ? 'minimize' : 'maximize'}
            className="ghost terminal-max"
            title={maximized ? tr('Restore terminal size') : tr('Maximize terminal (double-click the tab bar)')}
            aria-pressed={maximized}
            onClick={() => onMaximized(!maximized)}
          />
        )}
      </div>
      <div className="terminal-body">
        {terminals.map((t) => (
          <TerminalView key={t.id} info={t} visible={!collapsed && t.id === current?.id} />
        ))}
      </div>
    </section>
    </>
  );
}

function TerminalView({ info, visible }: { info: TerminalInfo; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);

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
    term.loadAddon(fit);
    term.open(ref.current!);
    termRef.current = { term, fit };

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

  return <div ref={ref} className="terminal-view" style={{ display: visible ? 'block' : 'none' }} />;
}
