import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeCache } from '../src/main/worktrees';
import { tmpDir } from './helpers';

const repo = () => {
  const root = tmpDir();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git('add', '-A');
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x');
  return { root, sha: git('rev-parse', 'HEAD'), cache: new WorktreeCache(root, tmpDir()) };
};
/** The state `git worktree add` leaves when it is killed during its checkout. */
const interrupt = (wt: string) => {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: wt, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(gitDir, 'locked'), 'initializing\n');
  fs.rmSync(path.join(wt, 'a.txt'));
};

describe('worktree cache', () => {
  it('reuses a complete worktree', async () => {
    const { sha, cache } = repo();
    const wt = await cache.ensure(sha);
    fs.writeFileSync(path.join(wt, 'marker'), '');
    expect(await cache.ensure(sha)).toBe(wt);
    expect(fs.existsSync(path.join(wt, 'marker'))).toBe(true);
  });

  it('recreates a worktree left partial by an interrupted add', async () => {
    const { sha, cache } = repo();
    const wt = await cache.ensure(sha);
    interrupt(wt);
    await cache.ensure(sha);
    expect(fs.existsSync(path.join(wt, 'a.txt'))).toBe(true);
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: wt, encoding: 'utf8' })).not.toContain('locked');
  });

  it('recreates it when only the lock is left and the directory is gone', async () => {
    const { sha, cache } = repo();
    const wt = await cache.ensure(sha);
    interrupt(wt);
    fs.rmSync(wt, { recursive: true });
    await cache.ensure(sha);
    expect(fs.existsSync(path.join(wt, 'a.txt'))).toBe(true);
  });
});
