import crypto from 'node:crypto';
import type { DB } from './db';
import type { Schedule, ScheduleAction, ScheduleFiring, ScheduleInput, ScheduleOutcome } from '../shared/types';

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

function toFiring(r: Row): ScheduleFiring {
  return {
    id: r.id as string,
    scheduleId: r.schedule_id as string,
    trigger: r.trigger_kind as ScheduleFiring['trigger'],
    outcome: r.outcome as ScheduleOutcome,
    reason: (r.reason as string) ?? null,
    jobIds: JSON.parse(r.job_ids as string),
    scheduledAt: (r.scheduled_at as string) ?? null,
    firedAt: r.fired_at as string,
  };
}

export class ScheduleStore {
  constructor(private readonly db: DB) {}

  private toSchedule(r: Row): Schedule {
    return {
      id: r.id as string,
      name: r.name as string,
      cron: r.cron as string,
      action: JSON.parse(r.action as string) as ScheduleAction,
      maxTokens: (r.max_tokens as number) ?? null,
      enabled: Boolean(r.enabled),
      nextAt: (r.next_at as string) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      lastFiring: this.firings(r.id as string, 1)[0] ?? null,
    };
  }

  list(): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedules WHERE removed_at IS NULL ORDER BY created_at').all() as Row[]).map((r) => this.toSchedule(r));
  }

  get(id: string): Schedule | undefined {
    const r = this.db.prepare('SELECT * FROM schedules WHERE id = ? AND removed_at IS NULL').get(id) as Row | undefined;
    return r && this.toSchedule(r);
  }

  /** Enabled schedules whose planned time has come. */
  due(at: string): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedules WHERE removed_at IS NULL AND enabled = 1 AND next_at <= ?').all(at) as Row[]).map((r) => this.toSchedule(r));
  }

  create(input: ScheduleInput, nextAt: string): Schedule {
    const id = crypto.randomUUID();
    const t = now();
    this.db
      .prepare('INSERT INTO schedules (id, name, cron, action, max_tokens, enabled, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .run(id, input.name, input.cron, JSON.stringify(input.action), input.maxTokens, nextAt, t, t);
    return this.get(id)!;
  }

  update(id: string, input: ScheduleInput, nextAt: string | null): Schedule {
    this.db
      .prepare('UPDATE schedules SET name = ?, cron = ?, action = ?, max_tokens = ?, next_at = ?, updated_at = ? WHERE id = ?')
      .run(input.name, input.cron, JSON.stringify(input.action), input.maxTokens, nextAt, now(), id);
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean, nextAt: string | null): Schedule {
    this.db.prepare('UPDATE schedules SET enabled = ?, next_at = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nextAt, now(), id);
    return this.get(id)!;
  }

  setNext(id: string, nextAt: string): void {
    this.db.prepare('UPDATE schedules SET next_at = ? WHERE id = ?').run(nextAt, id);
  }

  remove(id: string): void {
    this.db.prepare('UPDATE schedules SET removed_at = ?, enabled = 0, next_at = NULL WHERE id = ?').run(now(), id);
  }

  addFiring(f: Omit<ScheduleFiring, 'id' | 'firedAt'>): ScheduleFiring {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO schedule_firings (id, schedule_id, trigger_kind, outcome, reason, job_ids, scheduled_at, fired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, f.scheduleId, f.trigger, f.outcome, f.reason, JSON.stringify(f.jobIds), f.scheduledAt, now());
    return toFiring(this.db.prepare('SELECT * FROM schedule_firings WHERE id = ?').get(id) as Row);
  }

  /** Newest first; a limit of 0 or none returns all of them. */
  firings(scheduleId: string, limit = 0): ScheduleFiring[] {
    return (this.db.prepare('SELECT * FROM schedule_firings WHERE schedule_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?').all(scheduleId, limit || -1) as Row[]).map(toFiring);
  }

  /** The firing whose jobs a new one must not overlap. */
  lastStarted(scheduleId: string): ScheduleFiring | undefined {
    const r = this.db
      .prepare(`SELECT * FROM schedule_firings WHERE schedule_id = ? AND outcome = 'started' ORDER BY fired_at DESC, rowid DESC LIMIT 1`)
      .get(scheduleId) as Row | undefined;
    return r && toFiring(r);
  }
}
