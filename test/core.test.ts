import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import type { Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

async function waitFor<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let core: Core;
let repo: string;
let pid: string;

beforeAll(async () => {
  const home = tmpDir();
  const data = fs.realpathSync(tmpDir());
  repo = fs.realpathSync(tmpDir());
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  g('init', '-q');
  write(path.join(repo, 'a.txt'), 'a');
  write(path.join(repo, 'svc', 'Api.java'), 'class Api {}');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['limits', 'max_tokens_per_run'], 1000);
  doc.setIn(['queue', 'parallelism'], 1);
  fs.writeFileSync(cfgFile, doc.toString());

  core = new Core({ globalDir: home, dataDir: data, defaultsDir: DEFAULTS_DIR });
  await core.start();
  pid = (await core.addProject(repo)).id;
});

afterAll(() => core.shutdown());

const job = (id: string) => core.store(pid).getJob(id)!;
const settled = (j: Job) => waitFor(() => !['queued', 'running'].includes(job(j.id).status) && job(j.id));

describe('Core with a fake claude', () => {
  it('background run: worktree, MCP token scope, history, stream view', async () => {
    const j = await core.enqueueTask(pid, { role: 'task', prompt: 'go' });
    const done = await settled(j);
    expect(done.status).toBe('done');
    const run = core.store(pid).getRun(done.lastRunId!)!;
    expect(run.status).toBe('succeeded');
    expect(run.cwd).toContain(path.join('worktrees', run.commitSha));
    expect(run.usage.costUsd).toBe(0.001);
    const results = core.store(pid).listResults({ runId: run.id });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ entityId: j.entityId, data: { summary: `cwd=${run.cwd}` } });
    const term = core.terminals.list().find((t) => t.runId === run.id)!;
    expect(term.alive).toBe(false);
    expect(core.terminals.snapshot(term.id)).toMatch(/outside the token scope/);
    // The token died with the run; its MCP config file is gone.
    expect(fs.existsSync(path.join(core.paths.dataDir, pid, 'mcp', `${run.id}.json`))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
  });

  it('cancel stops the process', async () => {
    const j = await core.enqueueTask(pid, { role: 'task', prompt: 'SLEEP' });
    await waitFor(() => job(j.id).status === 'running' && job(j.id).lastRunId);
    core.cancelJob(pid, j.id);
    const done = await settled(j);
    expect(done.status).toBe('cancelled');
    expect(core.store(pid).getRun(done.lastRunId!)!.status).toBe('cancelled');
  });

  it('token limit kills the run', async () => {
    const done = await settled(await core.enqueueTask(pid, { role: 'task', prompt: 'TOKENS' }));
    expect(done.status).toBe('failed');
    expect(core.store(pid).getRun(done.lastRunId!)!.status).toBe('token_limit');
  });

  it('rate limit requeues and pauses the queue', async () => {
    const j = await core.enqueueTask(pid, { role: 'task', prompt: 'RATELIMIT' });
    await waitFor(() => core.queue.state().pausedUntil);
    expect(core.queue.state().pausedUntil).toBe(4102444800000);
    expect(job(j.id).status).toBe('queued');
    expect(core.store(pid).getRun(job(j.id).lastRunId!)!.status).toBe('rate_limited');
    core.cancelJob(pid, j.id);
    core.queue.resume();
  });

  it('take over: stream while alive, then interactive resume of the same session', async () => {
    const j = await core.enqueueTask(pid, { role: 'task', prompt: 'SLEEP' });
    const runId = (await waitFor(() => job(j.id).status === 'running' && job(j.id).lastRunId))!;
    const stream = await core.openRun(pid, runId);
    expect(core.terminals.list().find((t) => t.id === stream)!.mode).toBe('stream');
    const term = await core.takeOver(pid, j.id);
    expect(job(j.id).status).toBe('taken_over');
    const bg = core.store(pid).getRun(runId)!;
    expect(bg.status).toBe('taken_over');
    const info = core.terminals.list().find((t) => t.id === term)!;
    expect(info.mode).toBe('pty');
    await waitFor(() => core.terminals.snapshot(term).includes('fake interactive'));
    expect(core.terminals.snapshot(term)).toContain(`--resume ${bg.sessionId}`);
    expect(await core.openRun(pid, runId)).toBe(term);
    core.terminals.write(term, 'q\r');
    const resumed = core.store(pid).getRun(info.runId)!;
    expect(resumed).toMatchObject({ kind: 'interactive', parentRunId: runId, sessionId: bg.sessionId, entityId: j.entityId });
    await waitFor(() => core.store(pid).getRun(info.runId)!.status === 'exited');
  });

  it('free session runs in the repo root and reports new commits', async () => {
    const notices: string[] = [];
    core.on('event', (e) => e.type === 'notice' && notices.push(e.text));
    const term = await core.newSession(pid);
    const info = core.terminals.list().find((t) => t.id === term)!;
    const run = core.store(pid).getRun(info.runId)!;
    expect(run).toMatchObject({ cwd: repo, role: 'assistant', kind: 'interactive' });
    await waitFor(() => core.terminals.snapshot(term).includes('fake interactive --session-id'));
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'fix'], { cwd: repo });
    core.terminals.write(term, 'q\r');
    await waitFor(() => notices.some((n) => n.includes('changed HEAD')));
  });

  it('settings editor validates YAML and refuses files outside config dirs', () => {
    const file = path.join(core.paths.globalDir, 'config.yaml');
    expect(() => core.writeConfigFile(pid, file, 'queue: { parallelism: -1 }')).toThrow(/parallelism/);
    expect(() => core.readConfigFile(pid, path.join(repo, 'a.txt'))).toThrow(/cannot be edited/);
    expect(() => core.readConfigFile(pid, path.join(core.paths.globalDir, '..', 'x.yaml'))).toThrow(/cannot be edited/);
    const projectCfg = path.join(repo, '.aiegis', 'config.yaml');
    core.writeConfigFile(pid, projectCfg, 'roles: { task: { model: sonnet } }\n');
    expect(core.effectiveView(pid, 'task').model).toEqual({ value: 'sonnet', source: 'role task (project)' });
  });

  it('module markup and entry point maps: scope, cascade module level, versions', async () => {
    const markup = await core.enqueueModuleMarkup(pid, 'only svc');
    await expect(core.enqueueModuleMarkup(pid, '')).rejects.toThrow(/already has a queued job/);
    expect(markup).toMatchObject({ role: 'modules', entityType: 'module_map', entityId: pid, title: 'Module markup' });
    expect(String(markup.payload.prompt)).toContain('only svc');
    expect((await settled(markup)).status).toBe('done');
    const [mod] = await core.listModules(pid);
    expect(mod).toMatchObject({ name: 'svc', globs: ['svc/**'], author: 'ai:modules', latestSnapshot: null });

    write(path.join(repo, '.aiegis', 'config.yaml'), 'modules: { svc: { model: module-model } }\n');
    const j1 = await core.enqueueEntryPoints(pid, mod.id);
    expect(j1).toMatchObject({ role: 'entry-points', entityType: 'module', entityId: mod.id, title: 'Entry points: svc' });
    expect(String(j1.payload.prompt)).toContain('- svc/**');
    const d1 = await settled(j1);
    expect(d1.status).toBe('done');
    const run1 = core.store(pid).getRun(d1.lastRunId!)!;
    expect(run1.configSnapshot).toMatchObject({ model: { value: 'module-model', source: 'module svc' } });
    const map1 = core.entryPointMap(pid, mod.id);
    expect(map1.snapshot).toMatchObject({ runId: run1.id, status: 'complete', commitSha: run1.commitSha, touchedFiles: ['svc/Api.java'] });
    expect(map1.baseline).toBeNull();
    expect(map1.entries).toMatchObject([{ key: 'http GET /api', callChain: [{ sink: 'SQL' }] }]);

    const [d2] = await Promise.all((await core.enqueueAllEntryPoints(pid)).map(settled));
    expect(d2.status).toBe('done');
    const map2 = core.entryPointMap(pid, mod.id);
    expect(map2.snapshots).toHaveLength(2);
    expect(map2.baseline!.id).toBe(map1.snapshot!.id);
    expect(map2.entries.map((e) => e.change)).toEqual(['same']);
    expect((await core.listModules(pid))[0].latestSnapshot!.id).toBe(map2.snapshot!.id);
    // Older versions stay viewable.
    expect(core.entryPointMap(pid, mod.id, map1.snapshot!.id).entries).toHaveLength(1);

    await expect(core.saveModule(pid, { id: mod.id, name: 'svc', globs: ['nope/**'], description: '' })).rejects.toThrow(/match no repository file/);
    await core.saveModule(pid, { id: mod.id, name: 'svc', globs: ['svc/*.java'], description: 'edited' });
    expect(core.moduleHistory(pid, mod.id).map((h) => h.author)).toEqual(['human', 'ai:modules']);
    core.removeModule(pid, mod.id, 'test');
    await expect(core.enqueueEntryPoints(pid, mod.id)).rejects.toThrow(/not found/);
  });
});
