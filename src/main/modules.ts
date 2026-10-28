import fs from 'node:fs';
import path from 'node:path';
import type { EntryPoint, EntryPointChange, EntryPointInput } from '../shared/types';
import { git } from './git';

/** Entity of a module markup job: the module list of a project (id = project id). */
export const MODULE_MAP_ENTITY = 'module_map';
/** Entity of an entry point map job (id = module id). */
export const MODULE_ENTITY = 'module';

/** Returns an error message for an invalid glob list, or null. */
export function globsError(globs: string[]): string | null {
  if (!globs.some((g) => !g.startsWith('!'))) return 'нужен хотя бы один включающий glob';
  for (const g of globs) {
    const p = g.startsWith('!') ? g.slice(1) : g;
    if (!p.trim()) return 'пустой glob';
    if (p.startsWith('/') || p.startsWith(':')) return `glob "${g}" должен быть относительным путём без pathspec-магии`;
    if (p.split('/').includes('..')) return `glob "${g}" выходит за пределы репозитория`;
  }
  return null;
}

/** Module globs -> git pathspecs (`*` does not cross "/", `**` does; "!" excludes). */
export function toPathspecs(globs: string[]): string[] {
  return globs.map((g) => (g.startsWith('!') ? `:(glob,exclude)${g.slice(1)}` : `:(glob)${g}`));
}

/** Tracked files of the checkout in `cwd` matching module globs. */
export async function matchFiles(cwd: string, globs: string[]): Promise<string[]> {
  const err = globsError(globs);
  if (err) throw new Error(err);
  const out = await git(cwd, ['ls-files', '-z', '--', ...toPathspecs(globs)]);
  return out.split('\0').filter(Boolean);
}

/** Returns an error for a path that is not a file of the checkout in `cwd`, or null. */
export function repoFileError(cwd: string, rel: string): string | null {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return `путь ${rel} должен быть относительным от корня репозитория`;
  return fs.statSync(path.join(cwd, rel), { throwIfNoEntry: false })?.isFile() ? null : `файл ${rel} не найден`;
}

/** Fills `{{name}}` placeholders; an unknown placeholder is an error (templates are user-editable files). */
export function renderTemplate(template: string, vars: Record<string, string>, file = 'шаблон'): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`${file}: неизвестная подстановка {{${name}}}, доступны: ${Object.keys(vars).join(', ')}`);
    return vars[name];
  });
}

export function entryPointKey(e: Pick<EntryPointInput, 'kind' | 'method' | 'name'>): string {
  return [e.kind, (e.method ?? '').toUpperCase(), e.name.trim()].join(' ');
}

const content = (e: EntryPointInput) =>
  JSON.stringify([e.handler, e.middleware, e.auth, e.params, e.callChain, e.notes]);

/** Changes of `current` against `baseline` (matched by key); null baseline means nothing to compare with. */
export function diffEntryPoints(
  current: EntryPoint[],
  baseline: EntryPoint[] | null,
): { entries: (EntryPoint & { change: EntryPointChange })[]; removed: EntryPoint[] } {
  if (!baseline) return { entries: current.map((e) => ({ ...e, change: 'same' })), removed: [] };
  const prev = new Map(baseline.map((e) => [e.key, e]));
  const keys = new Set(current.map((e) => e.key));
  return {
    entries: current.map((e) => {
      const p = prev.get(e.key);
      return { ...e, change: !p ? 'added' : content(p) === content(e) ? 'same' : 'changed' };
    }),
    removed: baseline.filter((e) => !keys.has(e.key)),
  };
}

/** Files an entry point map depends on (SPEC §5): handlers and call chain steps. */
export function touchedFiles(entries: EntryPointInput[]): string[] {
  const files = new Set<string>();
  for (const e of entries) {
    files.add(e.handler.file);
    for (const c of e.callChain) files.add(c.file);
  }
  return [...files].sort();
}
