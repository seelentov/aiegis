import { z } from 'zod';
import type { ScheduleAction } from '../shared/types';

/** Thrown by runs with nothing to start, which is a normal outcome of a schedule (SPEC §25). */
export class NothingToDo extends Error {}

const id = z.string().min(1);
const ids = z.array(id);
const sliceIds = ids.min(1).optional();

const ActionSchema: z.ZodType<ScheduleAction> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task'), prompt: z.string().trim().min(1), role: id, title: z.string().optional() }),
  z.strictObject({
    kind: z.literal('matrix'),
    matrixId: id,
    stage: z.enum(['triage', 'verdicts']),
    scope: z.enum(['pending', 'stale']),
    slice: z.strictObject({ modules: sliceIds, requirements: sliceIds, section: z.string().optional(), cells: sliceIds }).optional(),
  }),
  z.strictObject({ kind: z.literal('scanners'), moduleIds: ids.nullable() }),
  z.strictObject({ kind: z.literal('sca_inventory'), moduleIds: ids.optional() }),
  z.strictObject({ kind: z.literal('sca'), scope: z.enum(['pending', 'stale']).optional(), moduleIds: ids.optional() }),
  z.strictObject({ kind: z.literal('entry_points'), moduleId: id.optional() }),
  z.strictObject({ kind: z.literal('doc_refresh'), target: z.union([z.strictObject({ setId: id }), z.strictObject({ documentId: id })]) }),
  z.strictObject({ kind: z.literal('diff_check'), baseRef: id, headRef: id, target: z.union([z.strictObject({ setId: id }), z.strictObject({ documentId: id })]) }),
]);

export function parseAction(raw: unknown): ScheduleAction {
  const r = ActionSchema.safeParse(raw);
  if (!r.success) throw new Error(`invalid schedule action: ${r.error.issues.map((i) => `${i.path.join('.') || 'action'}: ${i.message}`).join('; ')}`);
  return r.data;
}

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** A restricted day field: with both restricted, either of them matches. */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

function parseField(text: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid cron ${name}: "${part}"`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const from = m[1] === '*' ? min : Number(m[2]);
    const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from;
    if (step < 1 || from < min || to > max || from > to) throw new Error(`invalid cron ${name}: "${part}" (${min}-${max})`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`a cron expression has 5 fields (minute hour day month weekday): "${expr}"`);
  return {
    minute: parseField(f[0], 0, 59, 'minute'),
    hour: parseField(f[1], 0, 23, 'hour'),
    day: parseField(f[2], 1, 31, 'day'),
    month: parseField(f[3], 1, 12, 'month'),
    weekday: new Set([...parseField(f[4], 0, 7, 'weekday')].map((d) => d % 7)),
    dayRestricted: !f[2].startsWith('*'),
    weekdayRestricted: !f[4].startsWith('*'),
  };
}

const dayMatches = (c: Cron, d: Date): boolean => {
  const day = c.day.has(d.getDate());
  const weekday = c.weekday.has(d.getDay());
  return c.dayRestricted && c.weekdayRestricted ? day || weekday : day && weekday;
};

const wallClock = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());

/** Longest wait that still finds a February 29 across a skipped leap year. */
const SEARCH_MS = 9 * 366 * 86_400_000;

/** First matching minute after `after`, local time. */
export function nextFire(c: Cron, after: Date): Date {
  const start = after.getTime();
  const d = new Date(start - (start % 60_000) + 60_000);
  while (d.getTime() - start < SEARCH_MS) {
    // Steps go by the absolute time: setting local fields inside a repeated hour jumps back to its first pass.
    if (!c.month.has(d.getMonth() + 1) || !dayMatches(c, d)) {
      d.setTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
    } else if (!c.hour.has(d.getHours())) d.setTime(d.getTime() + (60 - d.getMinutes()) * 60_000);
    else if (!c.minute.has(d.getMinutes())) d.setTime(d.getTime() + 60_000);
    // A local time repeated when clocks go back fires once.
    else if (wallClock(d) <= wallClock(after)) d.setTime(d.getTime() + 60_000);
    else return d;
  }
  throw new Error('this cron expression never fires');
}

export function nextFires(c: Cron, after: Date, count: number): Date[] {
  const out: Date[] = [];
  for (let at = after; out.length < count; at = out[out.length - 1]) out.push(nextFire(c, at));
  return out;
}

/** Shortest wait between firings during a year from `from`, in minutes. */
export function shortestGapMinutes(c: Cron, from: Date, atLeast: number): number {
  let prev = nextFire(c, from);
  let gap = Infinity;
  const end = prev.getTime() + 366 * 86_400_000;
  while (prev.getTime() < end && gap >= atLeast) {
    const next = nextFire(c, prev);
    gap = Math.min(gap, (next.getTime() - prev.getTime()) / 60_000);
    prev = next;
  }
  return gap;
}
