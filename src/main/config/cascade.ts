import path from 'node:path';
import type { Instructions, Level } from './schema';

export interface Layer {
  /** Human-readable origin shown in "effective configuration", e.g. "role task (global)". */
  source: string;
  /** Directory instruction files are resolved against. */
  baseDir: string;
  level: Level;
}

export interface Sourced<T> {
  value: T;
  source: string;
}

export interface InstructionPart {
  source: string;
  /** File the text came from, if any. */
  file?: string;
  text: string;
}

export interface EffectiveLevel {
  agent?: Sourced<'claude' | 'pi'>;
  model?: Sourced<string>;
  effort?: Sourced<string>;
  instructions: InstructionPart[];
  permissions: {
    allow: Sourced<string>[];
    deny: Sourced<string>[];
    dirs: Sourced<string>[];
  };
  env: Record<string, Sourced<string>>;
}

export type ReadText = (file: string) => string;

function normalizeInstructions(i: Instructions): { mode: 'append' | 'replace'; text?: string; files: string[] } {
  if (typeof i === 'string') return { mode: 'append', text: i, files: [] };
  const files = i.file === undefined ? [] : Array.isArray(i.file) ? i.file : [i.file];
  return { mode: i.mode ?? 'append', text: i.text, files };
}

function pushUnique(list: Sourced<string>[], value: string, source: string): void {
  if (!list.some((e) => e.value === value)) list.push({ value, source });
}

/** Resolves cascade layers top-down (first layer = most general). Pure except for `readText`. */
export function resolveLevels(layers: Layer[], readText: ReadText): EffectiveLevel {
  const out: EffectiveLevel = { instructions: [], permissions: { allow: [], deny: [], dirs: [] }, env: {} };
  for (const { source, baseDir, level } of layers) {
    if (level.agent !== undefined) out.agent = { value: level.agent, source };
    if (level.model !== undefined) out.model = { value: level.model, source };
    if (level.effort !== undefined) out.effort = { value: level.effort, source };
    if (level.instructions !== undefined) {
      const ins = normalizeInstructions(level.instructions);
      if (ins.mode === 'replace') out.instructions = [];
      for (const f of ins.files) {
        const file = path.resolve(baseDir, f);
        out.instructions.push({ source, file, text: readText(file) });
      }
      if (ins.text !== undefined) out.instructions.push({ source, text: ins.text });
    }
    for (const a of level.permissions?.allow ?? []) pushUnique(out.permissions.allow, a, source);
    for (const d of level.permissions?.deny ?? []) pushUnique(out.permissions.deny, d, source);
    for (const d of level.permissions?.dirs ?? []) pushUnique(out.permissions.dirs, d, source);
    for (const [k, v] of Object.entries(level.env ?? {})) out.env[k] = { value: v, source };
  }
  return out;
}

/** Allow entries that survive "deny wins" (exact matches removed; pattern overlap is enforced by claude itself). */
export function effectiveAllow(level: EffectiveLevel): string[] {
  const denied = new Set(level.permissions.deny.map((d) => d.value));
  return level.permissions.allow.map((a) => a.value).filter((a) => !denied.has(a));
}

export function joinInstructions(level: EffectiveLevel): string {
  return level.instructions
    .map((p) => p.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

export type SourceMap = Record<string, string>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merges plain settings objects; later sources replace earlier ones per leaf (arrays are leaves).
 * Returns the merged value and a map "dotted.path -> source".
 */
export function mergeSettings(
  parts: { source: string; value: Record<string, unknown> | undefined }[],
): { value: Record<string, unknown>; sources: SourceMap } {
  const value: Record<string, unknown> = {};
  const sources: SourceMap = {};
  const walk = (target: Record<string, unknown>, src: Record<string, unknown>, prefix: string, source: string) => {
    for (const [k, v] of Object.entries(src)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v)) {
        if (!isPlainObject(target[k])) target[k] = {};
        walk(target[k] as Record<string, unknown>, v, key, source);
      } else {
        target[k] = v;
        sources[key] = source;
      }
    }
  };
  for (const p of parts) if (p.value) walk(value, p.value, '', p.source);
  return { value, sources };
}
