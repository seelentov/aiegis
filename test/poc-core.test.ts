import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import type { Finding, Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

let core: Core;
let repo: string;
let data: string;
let pid: string;
let port: number;
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
const job = (id: string) => core.store(pid).getJob(id)!;
const settled = (j: Job) => waitFor(() => !['queued', 'running'].includes(job(j.id).status) && job(j.id));
const finding = (title: string): Finding =>
  core.store(pid).audit.createFinding(
    { title, description: 'IDOR on orders', severity: 'high', cwe: 'CWE-639', moduleId: null, entryPoint: 'http GET /orders/{id}', files: [{ file: 'srv.js', line: 1 }], recommendation: null },
    [],
    { author: 'human', runId: null },
  );
const projectConfig = (poc: unknown) => write(path.join(repo, '.aiegis', 'config.yaml'), YAML.stringify({ poc }));

beforeAll(async () => {
  const home = tmpDir();
  data = fs.realpathSync(tmpDir());
  repo = fs.realpathSync(tmpDir());
  port = await freePort();
  git('init', '-q');
  write(path.join(repo, 'srv.js'), "require('http').createServer((q, r) => r.end('order of bob ' + q.url)).listen(process.env.PORT);\n");
  git('add', '.');
  git('commit', '-qm', 'init');

  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['poc', 'healthcheck_interval_sec'], 1);
  fs.writeFileSync(cfgFile, doc.toString());
  process.env.TEST_POC_ALICE = 'pw-alice';
  process.env.TEST_POC_SHELL_TOKEN = 'leak';

  core = new Core({ globalDir: home, dataDir: data, defaultsDir: DEFAULTS_DIR });
  await core.start();
  pid = (await core.addProject(repo)).id;
});

afterAll(() => core.shutdown());

describe('PoC tester with a fake claude', () => {
  it('is unavailable without a test environment', async () => {
    const f = finding('no env');
    const d = core.findingDetails(pid, f.id);
    expect(d.poc).toMatchObject({ available: false, results: [], job: null });
    expect(d.poc.reason).toContain('poc.environment');
    await expect(core.enqueuePoc(pid, f.id)).rejects.toThrow('unavailable');
  });

  it('starts the instance, confines the session to base_url, stores the result and stops the instance', async () => {
    const base = `http://127.0.0.1:${port}`;
    projectConfig({
      environment: {
        start: `PORT=${port} node srv.js`,
        healthcheck: `curl -sf ${base}/`,
        base_url: base,
        accounts: { alice: { username: 'alice', secrets: { password: { env: 'TEST_POC_ALICE' } } } },
      },
    });
    const f = finding('orders IDOR');
    const j = await core.enqueuePoc(pid, f.id);
    expect(String(j.payload.prompt)).toContain('`$AIEGIS_POC_ALICE_PASSWORD`');
    expect(String(j.payload.prompt)).not.toContain('pw-alice');
    await expect(core.enqueuePoc(pid, f.id)).rejects.toThrow('already has a queued job');

    const d = await settled(j);
    expect(d.status).toBe('done');
    const run = core.store(pid).getRun(d.lastRunId!)!;
    expect(run.cwd).toBe(path.join(data, pid, 'poc-worktrees', run.commitSha));
    const log = fs.readFileSync(run.logPath!, 'utf8');
    expect(log).toContain(`allowed=127.0.0.1:${port}`);
    expect(log).toContain('hook base=none');
    expect(log).toContain('hook other=deny');
    expect(log).toContain('secret=true');
    expect(log).toContain('shell token=absent');
    expect(log).toContain('scripts dir=true');
    expect(log).toContain('requires steps');
    expect(fs.readdirSync(path.join(data, pid, 'mcp')).filter((f) => f.startsWith(run.id))).toEqual([]);
    await expect(fetch(`${base}/`)).rejects.toThrow();

    const details = core.findingDetails(pid, f.id);
    expect(details.poc.results).toHaveLength(1);
    expect(details.poc.results[0]).toMatchObject({ outcome: 'reproduced', baseUrl: base, runId: run.id, author: 'ai:tester' });
    expect(details.poc.results[0].steps[0].result).toBe('order of bob /orders/2');
    expect(details.finding.status).toBe('suspected');
    expect(details.runs.map((r) => r.id)).toContain(run.id);
  });

  it('fails a run without a result, a broken environment, and non-suspected findings', async () => {
    const f = core.store(pid).audit.createFinding(
      { title: 'NO_RESULT', description: 'x', severity: 'low', cwe: null, moduleId: null, entryPoint: null, files: [], recommendation: null },
      [],
      { author: 'human', runId: null },
    );
    const d = await settled(await core.enqueuePoc(pid, f.id));
    expect(d.status).toBe('failed');
    expect(d.error).toContain('set_poc_result');

    const cfg = YAML.parse(fs.readFileSync(path.join(repo, '.aiegis', 'config.yaml'), 'utf8'));
    projectConfig({ ...cfg.poc, start_timeout_sec: 1, environment: { ...cfg.poc.environment, start: 'exit 7' } });
    const broken = await settled(await core.enqueuePoc(pid, finding('broken').id));
    expect(broken.status).toBe('failed');
    expect(broken.error).toContain('the test environment did not start');

    core.setFindingStatus(pid, f.id, 'verified', '');
    await expect(core.enqueuePoc(pid, f.id)).rejects.toThrow('suspected');
  });
});
