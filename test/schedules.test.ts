import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import { nextFire, nextFires, parseAction, parseCron, shortestGapMinutes } from '../src/main/schedules';
import type { AppEvent, Schedule, ScheduleInput } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

describe('cron', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });
  const local = (...a: [number, number, number, number, number]) => new Date(a[0], a[1] - 1, a[2], a[3], a[4]);

  it('rejects what is not an expression of 5 valid fields', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a * * * *', '5-1 * * * *', '*/0 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });

  it('finds the next minute of lists, ranges and steps', () => {
    const from = local(2026, 3, 2, 10, 7);
    expect(nextFire(parseCron('*/15 * * * *'), from)).toEqual(local(2026, 3, 2, 10, 15));
    expect(nextFire(parseCron('0 3 * * *'), from)).toEqual(local(2026, 3, 3, 3, 0));
    expect(nextFire(parseCron('5,40 9-11 * * *'), from)).toEqual(local(2026, 3, 2, 10, 40));
    expect(nextFire(parseCron('0 0 1 */3 *'), from)).toEqual(local(2026, 4, 1, 0, 0));
  });

  it('never returns the current minute', () => {
    expect(nextFire(parseCron('0 3 * * *'), local(2026, 3, 2, 3, 0))).toEqual(local(2026, 3, 3, 3, 0));
  });

  it('treats weekday 7 as Sunday and either of a restricted day and weekday as a match', () => {
    expect(nextFire(parseCron('0 0 * * 7'), local(2026, 3, 2, 0, 0)).getDay()).toBe(0);
    // March 2, 2026 is a Monday: Friday the 6th comes before the 15th.
    expect(nextFire(parseCron('0 0 15 * 5'), local(2026, 3, 2, 0, 0))).toEqual(local(2026, 3, 6, 0, 0));
  });

  it('finds February 29 and refuses a date that does not exist', () => {
    expect(nextFire(parseCron('0 0 29 2 *'), local(2026, 3, 2, 0, 0))).toEqual(local(2028, 2, 29, 0, 0));
    expect(() => nextFire(parseCron('0 0 31 2 *'), local(2026, 3, 2, 0, 0))).toThrow(/never fires/);
  });

  it('fires a repeated local hour once and skips one that does not exist', () => {
    process.env.TZ = 'Europe/Berlin';
    // 2026-10-25: 03:00 goes back to 02:00.
    const first = new Date('2026-10-25T00:30:00Z'); // 02:30 CEST
    expect(nextFire(parseCron('30 2 * * *'), new Date('2026-10-24T12:00:00Z'))).toEqual(first);
    expect(nextFire(parseCron('30 2 * * *'), first)).toEqual(new Date('2026-10-26T01:30:00Z'));
    // 2026-03-29: 02:00 goes forward to 03:00.
    expect(nextFire(parseCron('30 2 * * *'), new Date('2026-03-28T12:00:00Z'))).toEqual(new Date('2026-03-30T00:30:00Z'));
  });

  it('measures the shortest gap across the expression', () => {
    const from = local(2026, 3, 2, 0, 0);
    expect(shortestGapMinutes(parseCron('0,5 3 * * *'), from, 15)).toBe(5);
    expect(shortestGapMinutes(parseCron('*/15 * * * *'), from, 15)).toBe(15);
    expect(nextFires(parseCron('0 * * * *'), from, 3)).toHaveLength(3);
  });

  it('rejects an action outside the closed list', () => {
    expect(() => parseAction({ kind: 'removeModule', moduleId: 'x' })).toThrow(/invalid schedule action/);
    expect(() => parseAction({ kind: 'task', prompt: ' ', role: 'r' })).toThrow(/invalid schedule action/);
    expect(() => parseAction({ kind: 'scanners', moduleIds: [], extra: 1 })).toThrow(/invalid schedule action/);
    expect(() => parseAction({ kind: 'matrix', matrixId: 'm', stage: 'verdicts', scope: 'pending', slice: { modules: [] } })).toThrow(/invalid schedule action/);
  });
});

describe('schedules in the core', () => {
  let core: Core;
  let pid: string;
  let moduleId: string;
  let matrixId: string;
  let cell: string;
  const events: AppEvent[] = [];
  const taskInput = (name: string): ScheduleInput => ({ name, cron: '0 3 * * *', action: { kind: 'task', prompt: 'SECRET_PROMPT', role: 'task' }, maxTokens: null });
  /** A time after the planned one, inside the catch-up window. */
  const justAfter = (s: Schedule, ms = 1000) => new Date(Date.parse(s.nextAt!) + ms);
  const jobsOf = () => core.store(pid).listJobs();
  const drain = async () => {
    for (const j of jobsOf()) if (j.status === 'queued' || j.status === 'running') core.cancelJob(pid, j.id);
    for (let i = 0; i < 200 && jobsOf().some((j) => j.status === 'queued' || j.status === 'running'); i++) await new Promise((r) => setTimeout(r, 25));
  };

  beforeAll(async () => {
    const home = tmpDir();
    const data = fs.realpathSync(tmpDir());
    const repo = fs.realpathSync(tmpDir());
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    git('init', '-q');
    write(path.join(repo, 'svc', 'Api.java'), 'class Api {}');
    git('add', '.');
    git('commit', '-qm', 'init');
    ensureGlobalDefaults(DEFAULTS_DIR, home);
    const file = path.join(home, 'config.yaml');
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    doc.setIn(['claude', 'binary'], FAKE);
    doc.setIn(['queue', 'parallelism'], 1);
    doc.setIn(['signals', 'auto_scan'], false);
    fs.writeFileSync(file, doc.toString());
    core = new Core({ globalDir: home, dataDir: data, defaultsDir: DEFAULTS_DIR });
    core.on('event', (e: AppEvent) => events.push(e));
    await core.start();
    pid = (await core.addProject(repo)).id;
    moduleId = (await core.saveModule(pid, { name: 'svc', globs: ['svc/**'], description: '' })).id;

    const guide = path.join(tmpDir(), 'guide.md');
    write(guide, '# Access control\nAUTH-1: Every endpoint must check the role.\n');
    const view = await core.importDocument(pid, guide, { title: 'Guide' });
    while (core.docVersion(pid, view.version.id).version.status === 'extracting') await new Promise((r) => setTimeout(r, 25));
    core.reviewItems(pid, view.version.id, core.docVersion(pid, view.version.id).items.map((i) => i.id), 'accepted');
    core.approveVersion(pid, view.version.id);
    matrixId = core.saveMatrix(pid, { name: 'main', documentIds: [view.document.id], moduleIds: [moduleId] }).id;
    const c = (await core.matrixView(pid, matrixId)).cells[0];
    cell = `${c.moduleId}/${c.requirementId}`;

    // Firings are looked at while their jobs wait: nothing below runs an agent.
    void core.queue.close();
  });

  afterAll(() => core.shutdown());

  it('validates what is saved', async () => {
    await expect(core.createSchedule(pid, { ...taskInput('often'), cron: '*/5 * * * *' })).rejects.toThrow(/more often/);
    await expect(core.createSchedule(pid, { ...taskInput('bad'), cron: 'nope' })).rejects.toThrow(/5 fields/);
    await expect(core.createSchedule(pid, { ...taskInput('role'), action: { kind: 'task', prompt: 'x', role: 'nobody' } })).rejects.toThrow(/background role/);
    await expect(core.createSchedule(pid, { ...taskInput('limit'), maxTokens: 5 })).rejects.toThrow(/matrix, SCA/);
    await expect(core.createSchedule(pid, { ...taskInput('mod'), action: { kind: 'entry_points', moduleId: 'gone' } })).rejects.toThrow(/not found/);
    await expect(core.createSchedule(pid, { ...taskInput('matrix'), action: { kind: 'matrix', matrixId: 'gone', stage: 'verdicts', scope: 'pending' } })).rejects.toThrow();
    await core.createSchedule(pid, taskInput('same'));
    await expect(core.createSchedule(pid, taskInput('same'))).rejects.toThrow(/already exists/);
  });

  it('fires when due, moves the planned time and skips an overlap', async () => {
    const s = await core.createSchedule(pid, taskInput('fires'));
    await core.tickSchedules(new Date(Date.parse(s.nextAt!) - 60_000));
    expect(core.scheduleHistory(pid, s.id)).toHaveLength(0);

    const at = justAfter(s);
    await core.tickSchedules(at);
    const [first] = core.scheduleHistory(pid, s.id);
    expect(first).toMatchObject({ outcome: 'started', trigger: 'schedule', scheduledAt: s.nextAt });
    expect(jobsOf().find((j) => j.id === first.jobIds[0])?.status).toBe('queued');
    const moved = core.scheduleDetails(pid, s.id);
    expect(Date.parse(moved.nextAt!)).toBeGreaterThan(at.getTime());

    await core.tickSchedules(justAfter(moved));
    expect(core.scheduleHistory(pid, s.id)[0].outcome).toBe('overlap');
    expect(events.some((e) => e.type === 'notice' && e.text.includes('fires'))).toBe(false);
    await drain();
  });

  it('runs a missed firing once, counting lateness from the newest missed time, and only records an older one', async () => {
    const s = await core.createSchedule(pid, taskInput('late'));
    // Three planned times passed, the newest of them an hour ago.
    const at = new Date(Date.parse(s.nextAt!) + 2 * 86_400_000 + 3_600_000);
    await core.tickSchedules(at);
    const [firing, ...others] = core.scheduleHistory(pid, s.id);
    expect(others).toEqual([]);
    expect(firing).toMatchObject({ outcome: 'started', scheduledAt: new Date(Date.parse(s.nextAt!) + 2 * 86_400_000).toISOString() });
    await drain();

    const again = core.scheduleDetails(pid, s.id);
    expect(Date.parse(again.nextAt!)).toBeGreaterThan(at.getTime());
    await core.tickSchedules(new Date(Date.parse(again.nextAt!) + 13 * 3_600_000));
    expect(core.scheduleHistory(pid, s.id).map((f) => f.outcome)).toEqual(['missed', 'started']);
  });

  it('a manual firing has the same checks and leaves the planned time', async () => {
    const s = await core.createSchedule(pid, taskInput('manual'));
    const firing = await core.runSchedule(pid, s.id);
    expect(firing).toMatchObject({ outcome: 'started', trigger: 'manual', scheduledAt: null });
    expect(core.scheduleDetails(pid, s.id).nextAt).toBe(s.nextAt);
    expect((await core.runSchedule(pid, s.id)).outcome).toBe('overlap');
    await drain();
  });

  it('does not fire a disabled schedule, and enabling does not count the pause as missed', async () => {
    const s = await core.createSchedule(pid, taskInput('off'));
    expect(core.disableSchedule(pid, s.id)).toMatchObject({ enabled: false, nextAt: null });
    await core.tickSchedules(new Date(Date.now() + 10 * 86_400_000));
    expect(core.scheduleHistory(pid, s.id)).toHaveLength(0);
    const on = core.enableSchedule(pid, s.id);
    expect(Date.parse(on.nextAt!)).toBeGreaterThan(Date.now());
    core.disableSchedule(pid, s.id);
  });

  it('an edit recomputes the planned time only when the expression changes', async () => {
    const s = await core.createSchedule(pid, taskInput('edit'));
    expect((await core.updateSchedule(pid, s.id, { name: 'edited' })).nextAt).toBe(s.nextAt);
    const changed = await core.updateSchedule(pid, s.id, { cron: '0 4 * * *' });
    expect(new Date(changed.nextAt!).getHours()).toBe(4);
    core.disableSchedule(pid, s.id);
  });

  it('checks documents: an agent only when the sources changed, a fetch failure is a warning', async () => {
    const empty = core.saveDocSet(pid, { name: 'Empty', scope: '', links: [] });
    const action = (setId: string) => ({ kind: 'doc_refresh' as const, target: { setId } });
    await expect(core.createSchedule(pid, { name: 'no-links', cron: '0 3 * * *', action: action(empty.id), maxTokens: null })).rejects.toThrow(/no links/);

    const set = core.saveDocSet(pid, { name: 'Regulator', scope: 'orders', links: [{ url: 'https://example.invalid/list', insecure: false }] });
    const dear = await core.createSchedule(pid, { name: 'dear-check', cron: '0 3 * * *', action: action(set.id), maxTokens: 1 });
    expect((await core.runSchedule(pid, dear.id)).outcome).toBe('over_limit');
    core.disableSchedule(pid, dear.id);

    const s = await core.createSchedule(pid, { name: 'check', cron: '0 3 * * *', action: action(set.id), maxTokens: null });
    const refresh = core.refreshDocuments;
    try {
      core.refreshDocuments = async () => ({ job: null, compared: 1, unchanged: true, failed: [], reading: 0 });
      expect((await core.runSchedule(pid, s.id)).outcome).toBe('nothing_to_do');
      core.refreshDocuments = async () => ({ job: null, compared: 1, unchanged: false, failed: [{ url: 'https://example.invalid/list', error: 'down' }], reading: 0 });
      expect(await core.runSchedule(pid, s.id)).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('down') });
    } finally {
      core.refreshDocuments = refresh;
    }
    const started = await core.runSchedule(pid, s.id);
    expect(started.outcome).toBe('started');
    expect(jobsOf().find((j) => j.id === started.jobIds[0])?.status).toBe('queued');
    await drain();
    core.disableSchedule(pid, s.id);
  });

  it('removal hides the schedule and keeps its firings', async () => {
    const s = await core.createSchedule(pid, taskInput('gone'));
    await core.runSchedule(pid, s.id);
    await drain();
    core.removeSchedule(pid, s.id);
    expect(core.listSchedules(pid).map((x) => x.id)).not.toContain(s.id);
    expect(core.store(pid).schedules.firings(s.id)).toHaveLength(1);
    await core.createSchedule(pid, taskInput('gone'));
    expect(() => core.store(pid).db.exec('DELETE FROM schedule_firings')).toThrow(/append-only/);
  });

  describe('matrix actions', () => {
    it('does not start above the limit and warns', async () => {
      const s = await core.createSchedule(pid, { name: 'dear', cron: '0 3 * * *', action: { kind: 'matrix', matrixId, stage: 'verdicts', scope: 'pending' }, maxTokens: 1 });
      const firing = await core.runSchedule(pid, s.id);
      expect(firing.outcome).toBe('over_limit');
      expect(firing.jobIds).toEqual([]);
      expect(events.some((e) => e.type === 'notice' && e.level === 'warn' && e.text.includes('dear'))).toBe(true);
      core.disableSchedule(pid, s.id);
    });

    it('a slice takes only unchecked and stale cells; with none left there is nothing to do, without a notice', async () => {
      const slice = { kind: 'matrix' as const, matrixId, stage: 'verdicts' as const, scope: 'pending' as const, slice: { cells: [cell] } };
      const s = await core.createSchedule(pid, { name: 'slice', cron: '0 3 * * *', action: slice, maxTokens: null });
      expect((await core.runSchedule(pid, s.id)).outcome).toBe('started');
      await drain();
      await core.setVerdict(pid, cell, { status: 'pass', reason: 'checked', evidence: [{ file: 'svc/Api.java' }] });
      const before = events.filter((e) => e.type === 'notice').length;
      const firing = await core.runSchedule(pid, s.id);
      expect(firing.outcome).toBe('nothing_to_do');
      expect(events.filter((e) => e.type === 'notice').length).toBe(before);
      core.disableSchedule(pid, s.id);
    });

    it('rejects a slice of triage, and a cell outside the matrix', async () => {
      const base = { name: 'x', cron: '0 3 * * *', maxTokens: null };
      await expect(core.createSchedule(pid, { ...base, action: { kind: 'matrix', matrixId, stage: 'triage', scope: 'pending', slice: { cells: [cell] } } })).rejects.toThrow(/whole matrix/);
      await expect(core.createSchedule(pid, { ...base, action: { kind: 'matrix', matrixId, stage: 'verdicts', scope: 'pending', slice: { cells: ['a/b'] } } })).rejects.toThrow(/not in this matrix/);
    });

    it('a firing fails with a warning when what it refers to is gone, and stays enabled', async () => {
      const other = await core.saveModule(pid, { name: 'other', globs: ['svc/**'], description: '' });
      const s = await core.createSchedule(pid, { name: 'gone-module', cron: '0 3 * * *', action: { kind: 'entry_points', moduleId: other.id }, maxTokens: null });
      core.removeModule(pid, other.id, 'test');
      const firing = await core.runSchedule(pid, s.id);
      expect(firing.outcome).toBe('failed');
      expect(firing.reason).toMatch(/not found/);
      expect(events.some((e) => e.type === 'notice' && e.level === 'warn' && e.text.includes('gone-module'))).toBe(true);
      expect(core.scheduleDetails(pid, s.id).enabled).toBe(true);
      core.disableSchedule(pid, s.id);
    });
  });
});
