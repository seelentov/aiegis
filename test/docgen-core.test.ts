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
let pid: string;

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
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['queue', 'parallelism'], 1);
  fs.writeFileSync(cfgFile, doc.toString());
  core = new Core({ globalDir: home, dataDir: data, defaultsDir: DEFAULTS_DIR });
  await core.start();
  pid = (await core.addProject(repo)).id;
  await core.saveModule(pid, { name: 'svc', globs: ['svc/**'], description: 'api' });
});

afterAll(() => core.shutdown());

const settled = (id: string) => waitFor(() => !['queued', 'running'].includes(core.store(pid).getJob(id)!.status) && core.store(pid).getJob(id)!);
const writers = () => core.store(pid).listJobs(100).filter((j) => j.entityType === 'doc_gen');

describe('AI-written security documents with a fake claude', () => {
  it('plan -> one writer per document -> versions in review without extraction', async () => {
    const plan = await core.enqueueDocPlan(pid, 'focus on tokens');
    expect(plan).toMatchObject({ role: 'doc-author', entityType: 'doc_plan', entityId: pid });
    expect(String(plan.payload.prompt)).toContain('focus on tokens');
    expect(String(plan.payload.prompt)).toContain('- svc (module_id');
    expect((await settled(plan.id)).status).toBe('done');
    // The plan with an unknown module was rejected, the second one was accepted.
    expect(fs.readFileSync(core.store(pid).getRun(core.store(pid).getJob(plan.id)!.lastRunId!)!.logPath!, 'utf8')).toContain('unknown modules nope');

    const ws = await waitFor(() => writers().length === 2 && writers());
    const prompt = String(ws.find((j) => j.entityId === 'authn')!.payload.prompt);
    expect(prompt).toContain('these modules:\n- svc');
    expect(prompt).toContain('"Data protection" (DATA): stored data');
    for (const j of ws) expect((await settled(j.id)).status).toBe('done');

    const docs = core.listDocuments(pid);
    const authn = docs.find((d) => d.generated?.slug === 'authn')!;
    expect(authn).toMatchObject({ title: 'Authentication', generated: { key_prefix: 'AUTHN', modules: ['svc'] } });
    const v = core.docVersion(pid, authn.versions[0].id);
    expect(v.version).toMatchObject({ status: 'review', filename: 'authn.md', format: 'md' });
    expect(v.job).toBeNull();
    expect(v.items.map((i) => [i.key, i.section, i.review, i.author])).toEqual([
      ['AUTHN-1', 'First', 'pending', 'ai:doc-author'],
      ['AUTHN-2', 'First', 'pending', 'ai:doc-author'],
      ['AUTHN-3', 'Second', 'pending', 'ai:doc-author'],
    ]);
    expect(v.items[0].quote).toBe('Every request must be authenticated.');
  });

  it('rewrite: blocked while a version is unapproved; unchanged requirements are carried over', async () => {
    const authn = core.listDocuments(pid).find((d) => d.generated?.slug === 'authn')!;
    await expect(core.regenerateDocument(pid, authn.id, '')).rejects.toThrow(/unapproved version v1/);
    const v1 = authn.versions[0];
    core.reviewItems(pid, v1.id, core.docVersion(pid, v1.id).items.map((i) => i.id), 'accepted');
    core.approveVersion(pid, v1.id);

    const j: Job = await core.regenerateDocument(pid, authn.id, '');
    expect(String(j.payload.prompt)).toContain('- **AUTHN-1** [First] Every request must be authenticated.');
    expect((await settled(j.id)).status).toBe('done');
    const v2 = core.listDocuments(pid).find((d) => d.id === authn.id)!.versions[0];
    const view = core.docVersion(pid, v2.id);
    expect(view.items.map((i) => [i.key, i.change, i.author]).sort()).toEqual([
      ['AUTHN-1', 'same', 'auto'],
      ['AUTHN-2', 'changed', 'ai:doc-author'],
      ['AUTHN-3', 'same', 'auto'],
    ]);
    const upload = core.listDocuments(pid).find((d) => d.generated?.slug === 'data')!;
    await expect(core.regenerateDocument(pid, upload.id, '')).rejects.toThrow(/unapproved/);
  });
});
