import net from 'node:net';
import type { AppEvent } from '../shared/types';
import { LineSplitter } from '../main/claude/stream';
import type { Request, Response } from './service';

/** The service is not listening on the socket. */
export class NotRunning extends Error {}

export class Client {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private onEvent: (e: AppEvent) => void = () => undefined;

  private constructor(private readonly conn: net.Socket) {
    const lines = new LineSplitter();
    conn.setEncoding('utf8');
    conn.on('data', (d: string) => lines.push(d).forEach((l) => this.receive(JSON.parse(l) as Response)));
    conn.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('the service closed the connection'));
      this.pending.clear();
      this.onClose();
    });
  }

  /** Called when the service goes away. */
  onClose: () => void = () => undefined;

  static connect(file: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const conn = net.connect(file);
      conn.once('connect', () => {
        conn.removeAllListeners('error');
        conn.on('error', () => undefined);
        resolve(new Client(conn));
      });
      conn.once('error', (e: NodeJS.ErrnoException) => {
        reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new NotRunning(`the aiegis service is not running (${file})`) : e);
      });
    });
  }

  private receive(r: Response): void {
    if ('event' in r) return this.onEvent(r.event);
    const p = this.pending.get(r.id);
    this.pending.delete(r.id);
    if (r.error !== undefined) p?.reject(new Error(r.error));
    else p?.resolve(r.result);
  }

  request(method: string, args: unknown[] = []): Promise<unknown> {
    const req: Request = { id: this.nextId++, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      this.conn.write(JSON.stringify(req) + '\n');
    });
  }

  /** Delivers app events; with a terminal also its output, and returns its scrollback. */
  async subscribe(onEvent: (e: AppEvent) => void, terminalId?: string): Promise<string> {
    this.onEvent = onEvent;
    const { snapshot } = (await this.request('subscribe', terminalId ? [terminalId] : [])) as { snapshot: string };
    return snapshot;
  }

  close(): void {
    this.conn.destroy();
  }
}
