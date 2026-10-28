import fs from 'node:fs';
import path from 'node:path';
import { git } from './git';

/** Detached git worktrees cached by commit SHA, stored outside the repository (SPEC §1, Q6). */
export class WorktreeCache {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly repoRoot: string,
    private readonly dir: string,
  ) {}

  pathFor(sha: string): string {
    return path.join(this.dir, sha);
  }

  ensure(sha: string): Promise<string> {
    let p = this.pending.get(sha);
    if (!p) {
      p = this.create(sha).finally(() => this.pending.delete(sha));
      this.pending.set(sha, p);
    }
    return p;
  }

  private async create(sha: string): Promise<string> {
    const wt = this.pathFor(sha);
    if (fs.existsSync(path.join(wt, '.git'))) {
      const head = await git(wt, ['rev-parse', 'HEAD']).catch(() => '');
      if (head === sha) return wt;
      fs.rmSync(wt, { recursive: true, force: true });
    }
    fs.mkdirSync(this.dir, { recursive: true });
    await git(this.repoRoot, ['worktree', 'prune']);
    await git(this.repoRoot, ['worktree', 'add', '--detach', wt, sha]);
    return wt;
  }
}
