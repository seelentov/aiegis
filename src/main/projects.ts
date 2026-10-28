import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './git';

export interface Project {
  id: string;
  name: string;
  root: string;
  addedAt: string;
}

/** Registry of projects known to the app (dataDir/projects.json). Not settings, so it is not part of the cascade. */
export class ProjectRegistry {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'projects.json');
  }

  list(): Project[] {
    if (!fs.existsSync(this.file)) return [];
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Project[];
  }

  get(id: string): Project {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new Error(`проект ${id} не найден`);
    return p;
  }

  async add(dir: string): Promise<Project> {
    let root: string;
    try {
      root = fs.realpathSync(await repoRoot(dir));
    } catch {
      throw new Error(`${dir} не является git-репозиторием`);
    }
    const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
    const list = this.list();
    const existing = list.find((p) => p.id === id);
    if (existing) return existing;
    const project: Project = { id, name: path.basename(root), root, addedAt: new Date().toISOString() };
    this.save([...list, project]);
    return project;
  }

  remove(id: string): void {
    this.save(this.list().filter((p) => p.id !== id));
  }

  private save(list: Project[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
  }
}
