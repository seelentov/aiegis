import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import { scaItemId } from '../src/main/sca';
import type { Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let core: Core;
let repo: string;
let data: string;
let pid: string;
let moduleId: string;
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });

beforeAll(async () => {
  const home = tmpDir();
  data = fs.realpathSync(tmpDir());
  repo = fs.realpathSync(tmpDir());
  git('init', '-q');
  write(path.join(repo, 'svc', 'Api.java'), 'import com.acme.json.Parser;\nclass Api { Object p = Parser.parse(body); }\n');
  write(path.join(repo, 'svc', 'build.gradle'), "dependencies { implementation 'com.acme:json:1.0' }\n");
  write(path.join(repo, 'other', 'Main.java'), 'class Main {}\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['queue', 'parallelism'], 2);
  doc.setIn(['signals', 'auto_scan'], false);
  fs.writeFileSync(cfgFile, doc.toString());

  core = new Core({ globalDir: home, dataDir: data, defaultsDir: DEFAULTS_DIR });
  await core.start();
  pid = (await core.addProject(repo)).id;
  moduleId = (await core.saveModule(pid, { name: 'svc', globs: ['svc/**'], description: 'api' })).id;
});

afterAll(() => core.shutdown());

const job = (id: string) => core.store(pid).getJob(id)!;
const settled = (j: Job) => waitFor(() => !['queued', 'running'].includes(job(j.id).status) && job(j.id));

describe('SCA with a fake claude', () => {
  it('inventory: inputs staged in the run directory, separate worktree, reports checked against tool output', async () => {
    const lock = path.join(tmpDir(), 'deps.lock');
    write(lock, 'com.acme:json:1.0\n');
    const input = await core.addScaInput(pid, lock, { moduleId, note: 'lock from CI' });
    expect(input).toMatchObject({ filename: 'deps.lock', moduleId, note: 'lock from CI' });

    const [j] = await core.enqueueScaInventories(pid);
    expect(String(j.payload.prompt)).toContain(`deps.lock — lock from CI`);
    await expect(core.enqueueScaInventories(pid)).resolves.toEqual([]);
    const d = await settled(j);
    expect(d.status).toBe('done');
    const run = core.store(pid).getRun(d.lastRunId!)!;
    expect(run.cwd).toBe(path.join(data, pid, 'sca-worktrees', run.commitSha));
    const log = fs.readFileSync(run.logPath!, 'utf8');
    expect(log).toContain(`inputs: ${input.id.slice(0, 8)}-deps.lock`);
    expect(log).toContain('has no vulnerabilities: CVE-404');
    expect(log).toContain('report ../outside.json not found');
    expect(log).toContain('not tracked by git (generated?): svc/gradle.lockfile');

    const view = await core.scaView(pid);
    const m = view.modules.find((x) => x.module.id === moduleId)!;
    expect(m.inventory).toMatchObject({ status: 'complete', packageCount: 3, vulnCount: 4 });
    expect(m.inventory!.summary).toMatchObject({ tools: ['fake-gradle', 'fake-trivy'], dependenciesTotal: 12, manifests: ['svc/build.gradle'] });
    expect(m.items.map((x) => x.vulnId).sort()).toEqual(['CVE-1', 'CVE-2', 'CVE-3', 'CVE-4']);
    expect(m.items.every((x) => x.status === 'not_checked')).toBe(true);
    const rep = core.store(pid).sca.listReports(m.inventory!.id);
    expect(rep).toHaveLength(1);
    expect(fs.existsSync(core.scaReportPath(pid, rep[0].id))).toBe(true);
    // The inventory writes into its own worktree; the regular one of the commit is not touched by it.
    expect(fs.existsSync(path.join(data, pid, 'worktrees', run.commitSha, '.aiegis-sca'))).toBe(false);
  });

  it('dry-run: the prefilter closes unreferenced packages without AI, one session per remaining package', async () => {
    const e = await core.estimateSca(pid, { scope: 'pending' });
    expect(e).toMatchObject({ items: 4, auto: 1, sessions: 2, tokensPerSessionSource: 'config', busy: 0 });
    expect(e.packages.map((p) => p.packageKey).sort()).toEqual(['maven:com.acme:json@1.0', 'maven:net.mystery:x@3.0']);
    expect(core.store(pid).sca.latestVerdicts().size).toBe(0);
  });

  it('reachability: auto verdicts, AI verdicts with evidence, reachable needs a finding', async () => {
    const r = await core.runSca(pid, { scope: 'pending' });
    expect(r.auto).toBe(1);
    expect(r.jobs).toHaveLength(2);
    await expect(core.runSca(pid, { scope: 'pending' })).rejects.toThrow(/already queued/);
    for (const j of r.jobs) expect((await settled(j)).status).toBe('done');

    const items = (await core.scaView(pid)).modules.find((x) => x.module.id === moduleId)!.items;
    const by = (v: string) => items.find((x) => x.vulnId === v)!;
    expect(by('CVE-3')).toMatchObject({ status: 'not_reachable', verdict: { author: 'auto' } });
    expect(by('CVE-3').verdict!.reason).toContain('org.unused');
    expect(by('CVE-1')).toMatchObject({ status: 'reachable', findingCount: 1, verdict: { author: 'ai:sca' } });
    expect(by('CVE-2')).toMatchObject({ status: 'not_reachable', verdict: { author: 'ai:sca' } });
    expect(by('CVE-4')).toMatchObject({ status: 'needs_human' });
    expect(by('CVE-1').verdict!.touchedFiles).toEqual(['svc/Api.java', 'svc/build.gradle']);

    const pkgJob = r.jobs.find((j) => String(j.payload.package_key).includes('acme'))!;
    const log = fs.readFileSync(core.store(pid).getRun(job(pkgJob.id).lastRunId!)!.logPath!, 'utf8');
    expect(log).toContain('early: rejected');
    expect(log).toContain('no evidence: rejected');
    expect(String(pkgJob.payload.prompt)).toContain('- svc/Api.java');

    const f = core.listFindings(pid).find((x) => x.title === 'Vulnerable JSON parser reachable')!;
    expect(f.scaItems).toEqual([{ moduleId, packageKey: 'maven:com.acme:json@1.0', vulnId: 'CVE-1' }]);
    expect(f.cells).toEqual([]);
    const fd = core.findingDetails(pid, f.id);
    expect(fd.scaItems[0]).toMatchObject({ vulnId: 'CVE-1', moduleName: 'svc' });

    const details = await core.scaItemDetails(pid, scaItemId(by('CVE-1')));
    expect(details.findings.map((x) => x.id)).toEqual([f.id]);
    expect(details.importHits).toEqual(['svc/Api.java']);
    expect(details.report?.path).toMatch(/report\.json$/);
    expect(details.config?.role.name).toBe('sca');
  });

  it('manual verdicts and findings: reachable needs a linked finding; human verdict is a new record', async () => {
    const id = scaItemId({ moduleId, packageKey: 'maven:net.mystery:x@3.0', vulnId: 'CVE-4' });
    await expect(core.setScaVerdict(pid, id, { status: 'reachable', reason: 'used', evidence: [] })).rejects.toThrow(/finding/);
    const f = core.createScaFinding(pid, id, { title: 'x reachable', description: 'd', severity: 'medium', cwe: null, entryPoint: null, files: [{ file: 'svc/Api.java' }], recommendation: null });
    const v = await core.setScaVerdict(pid, id, { status: 'reachable', reason: 'checked by hand', evidence: [{ file: 'svc/Api.java', line: 2 }] });
    expect(v).toMatchObject({ author: 'human', status: 'reachable' });
    const d = await core.scaItemDetails(pid, id);
    expect(d.verdicts.map((x) => x.status)).toEqual(['reachable', 'needs_human']);
    expect(d.findings.map((x) => x.id)).toEqual([f.id]);
    // Merging moves SCA links too.
    const other = core.listFindings(pid).find((x) => x.title === 'Vulnerable JSON parser reachable')!;
    const merged = core.mergeFinding(pid, f.id, other.id);
    expect(merged.scaItems.map((x) => x.vulnId).sort()).toEqual(['CVE-1', 'CVE-4']);
  });

  it('staleness: module code changes make verdicts stale, build files make the inventory stale', async () => {
    write(path.join(repo, 'other', 'Main.java'), 'class Main { int x; }\n');
    git('commit', '-qam', 'unrelated');
    let m = (await core.scaView(pid)).modules.find((x) => x.module.id === moduleId)!;
    expect(m.items.some((x) => x.stale)).toBe(false);
    expect(m.inventoryStale).toBe(false);

    write(path.join(repo, 'svc', 'Api.java'), 'import com.acme.json.Parser;\nclass Api { Object p = Parser.parse(body2); }\n');
    git('commit', '-qam', 'module code');
    m = (await core.scaView(pid)).modules.find((x) => x.module.id === moduleId)!;
    expect(m.items.every((x) => x.stale)).toBe(true);
    expect(m.inventoryStale).toBe(false);
    const e = await core.estimateSca(pid, { scope: 'stale' });
    expect(e).toMatchObject({ items: 4, auto: 1, sessions: 2 });

    write(path.join(repo, 'svc', 'build.gradle'), "dependencies { implementation 'com.acme:json:1.1' }\n");
    git('commit', '-qam', 'bump');
    m = (await core.scaView(pid)).modules.find((x) => x.module.id === moduleId)!;
    expect(m.inventoryStale).toBe(true);
  });

  it('a run that does not finish its inventory fails and leaves no current inventory', async () => {
    const mod = await core.saveModule(pid, { name: 'other', globs: ['other/**'], description: 'NO_SUMMARY' });
    const [j] = await core.enqueueScaInventories(pid, [mod.id]);
    const d = await settled(j);
    expect(d.status).toBe('failed');
    expect(d.error).toMatch(/set_inventory_summary/);
    const m = (await core.scaView(pid)).modules.find((x) => x.module.id === mod.id)!;
    expect(m.inventory).toBeNull();
    expect(m.failedJob?.id).toBe(j.id);
    expect(core.store(pid).sca.listInventories(mod.id)[0].status).toBe('failed');
  });

  it('removing an input is recorded once', async () => {
    const [i] = core.store(pid).sca.listInputs();
    await core.removeScaInput(pid, i.id);
    await expect(core.removeScaInput(pid, i.id)).rejects.toThrow(/already excluded/);
    expect(core.store(pid).sca.inputsFor(moduleId)).toEqual([]);
  });
});
