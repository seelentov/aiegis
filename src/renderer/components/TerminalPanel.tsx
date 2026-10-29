import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import type { AppEvent, TerminalInfo } from '../../shared/types';
import { api, bridge } from '../api';
import type { RunFn } from '../App';
import { Icon, IconButton } from './Icon';
import { Splitter } from './Splitter';

interface Props {
  terminals: TerminalInfo[];
  active: string | null;
  onActivate: (id: string | null) => void;
  run: RunFn;
  height: number;
  onHeight: (h: number) => void;
}

export function TerminalPanel({ terminals, active, onActivate, run, height, onHeight }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const current = terminals.find((t) => t.id === active) ?? terminals[terminals.length - 1] ?? null;

  useEffect(() => {
    if (active && terminals.some((t) => t.id === active)) setCollapsed(false);
  }, [active, terminals]);

  const close = (t: TerminalInfo) => {
    if (t.mode === 'pty' && t.alive && !confirm('Закрыть вкладку и завершить процесс claude?')) return;
    void run(api.terminalClose(t.id));
    if (t.id === active) onActivate(null);
  };

  const open = !collapsed && terminals.length > 0;
  return (
    <>
      {open && (
        <Splitter axis="y" invert value={height} onChange={onHeight} min={120} max={Math.round(window.innerHeight * 0.8)} reset={320} label="Высота терминала" />
      )}
    <section className={open ? 'terminal-panel' : 'terminal-panel collapsed'} style={open ? { height } : undefined}>
      <div className="terminal-tabs">
        <IconButton
          icon={collapsed ? 'chevronUp' : 'chevronDown'}
          className="ghost"
          disabled={terminals.length === 0}
          title={collapsed ? 'Развернуть терминал' : 'Свернуть терминал'}
          onClick={() => setCollapsed((c) => !c)}
        />
        <Icon name="terminal" />
        {terminals.length === 0 && <span className="muted small">Сессий нет: откройте сессию из очереди или деталей</span>}
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`terminal-tab ${t.id === current?.id ? 'active' : ''} ${t.alive ? '' : 'dead'}`}
            onClick={() => (onActivate(t.id), setCollapsed(false))}
          >
            {t.mode === 'stream' && <Icon name="output" size={12} />}
            <span title={t.mode === 'stream' ? 'только чтение' : undefined}>{t.title}</span>
            <IconButton icon="close" className="ghost" title="Закрыть вкладку" onClick={(e) => (e.stopPropagation(), close(t))} />
          </div>
        ))}
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
