import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { TerminalInfo } from '../shared/types';
import { pickEnv } from './poc';

const SCROLLBACK_LIMIT = 2 * 1024 * 1024;

interface Entry {
  info: TerminalInfo;
  buffer: string;
  proc?: pty.IPty;
}

export interface PtySpec {
  projectId: string;
  runId: string;
  title: string;
  cwd: string;
  binary: string;
  args: string[];
  env: Record<string, string>;
  /** Variables of the app's environment the process inherits; all when unset. */
  inherit?: string[];
  onExit?: (exitCode: number) => void;
}

/**
 * Terminal panel backend: read-only stream views of background runs and interactive PTYs.
 * Emits "data" (id, chunk) and "changed".
 */
export class Terminals extends EventEmitter {
  private readonly entries = new Map<string, Entry>();

  list(): TerminalInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  findByRun(runId: string, mode?: TerminalInfo['mode']): TerminalInfo | undefined {
    return this.list().find((t) => t.runId === runId && (!mode || t.mode === mode) && t.alive);
  }

  snapshot(id: string): string {
    return this.entries.get(id)?.buffer ?? '';
  }

  openStream(projectId: string, runId: string, title: string): string {
    const id = crypto.randomUUID();
    this.entries.set(id, { info: { id, title, mode: 'stream', projectId, runId, alive: true }, buffer: '' });
    this.emit('changed');
    return id;
  }

  append(id: string, data: string): void {
    const e = this.entries.get(id);
    if (!e || !data) return;
    e.buffer += data;
    if (e.buffer.length > SCROLLBACK_LIMIT) e.buffer = e.buffer.slice(-SCROLLBACK_LIMIT);
    this.emit('data', id, data);
  }

  markEnded(id: string): void {
    const e = this.entries.get(id);
    if (!e || !e.info.alive) return;
    e.info.alive = false;
    this.emit('changed');
  }

  openPty(spec: PtySpec): string {
    const id = crypto.randomUUID();
    const proc = pty.spawn(spec.binary, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spec.cwd,
      env: { ...(spec.inherit ? pickEnv(spec.inherit) : (process.env as Record<string, string>)), ...spec.env, TERM: 'xterm-256color' },
    });
    const entry: Entry = {
      info: { id, title: spec.title, mode: 'pty', projectId: spec.projectId, runId: spec.runId, alive: true },
      buffer: '',
      proc,
    };
    this.entries.set(id, entry);
    proc.onData((d) => this.append(id, d));
    proc.onExit(({ exitCode }) => {
      entry.proc = undefined;
      this.append(id, `\r\n\x1b[2m[process exited, code ${exitCode}]\x1b[0m\r\n`);
      this.markEnded(id);
      spec.onExit?.(exitCode);
    });
    this.emit('changed');
    return id;
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.proc?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.entries.get(id)?.proc;
    if (p && cols > 0 && rows > 0) p.resize(cols, rows);
  }

  /** Removes the tab; kills the PTY if it is still running. */
  close(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.proc?.kill();
    this.entries.delete(id);
    this.emit('changed');
  }

  killAll(): void {
    for (const e of this.entries.values()) e.proc?.kill();
  }
}
