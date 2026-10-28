import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigFileSchema, SETTINGS_KEYS, type ConfigFile, type Level } from './schema';
import { mergeSettings, resolveLevels, type EffectiveLevel, type Layer, type ReadText, type SourceMap } from './cascade';

export class ConfigError extends Error {}

export interface ConfigLocation {
  /** ~/.aiegis (global defaults). */
  globalDir: string;
  /** Repository root of the project, if resolving for a project. */
  projectRoot?: string;
}

export interface LoadedFile {
  path: string;
  baseDir: string;
  exists: boolean;
  data: ConfigFile;
}

export const SOURCE_GLOBAL = 'глобальный';
export const SOURCE_PROJECT = 'проект';

export function globalConfigPath(globalDir: string): string {
  return path.join(globalDir, 'config.yaml');
}

export function projectConfigDir(projectRoot: string): string {
  return path.join(projectRoot, '.aiegis');
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectConfigDir(projectRoot), 'config.yaml');
}

/** Parses and validates YAML text of a config file; throws ConfigError with a readable message. */
export function parseConfigText(text: string, file: string): ConfigFile {
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? {};
  } catch (e) {
    throw new ConfigError(`${file}: ошибка YAML: ${(e as Error).message}`);
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new ConfigError(`${file}: ${issues}`);
  }
  return parsed.data;
}

export function loadConfigFile(file: string): LoadedFile {
  const baseDir = path.dirname(file);
  if (!fs.existsSync(file)) return { path: file, baseDir, exists: false, data: {} };
  return { path: file, baseDir, exists: true, data: parseConfigText(fs.readFileSync(file, 'utf8'), file) };
}

export interface RoleInfo {
  name: string;
  title: string;
  kind: 'interactive' | 'background';
  mcp_access: 'manage' | 'scoped';
}

export interface Settings {
  claude: { binary: string; background_args: string[]; interactive_args: string[] };
  queue: { parallelism: number; rate_limit_fallback_pause_sec: number };
  limits: { max_tokens_per_run: number };
  terminal: { external_app: string };
  sessions: { free_role: string; default_task_role: string };
}

export interface EffectiveConfig {
  role: RoleInfo;
  level: EffectiveLevel;
  layers: { source: string; file?: string }[];
  settings: Settings;
  settingsSources: SourceMap;
}

export interface ResolveTarget {
  role: string;
  module?: string;
}

const REQUIRED_SETTINGS: string[] = [
  'claude.binary',
  'claude.background_args',
  'claude.interactive_args',
  'queue.parallelism',
  'queue.rate_limit_fallback_pause_sec',
  'limits.max_tokens_per_run',
  'terminal.external_app',
  'sessions.free_role',
  'sessions.default_task_role',
];

function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const readText: ReadText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`не найден файл инструкций: ${file}`);
  }
};

export function loadFiles(loc: ConfigLocation): { global: LoadedFile; project?: LoadedFile } {
  return {
    global: loadConfigFile(globalConfigPath(loc.globalDir)),
    project: loc.projectRoot ? loadConfigFile(projectConfigPath(loc.projectRoot)) : undefined,
  };
}

export function listRoles(loc: ConfigLocation): RoleInfo[] {
  const { global, project } = loadFiles(loc);
  const names = new Set([...Object.keys(global.data.roles ?? {}), ...Object.keys(project?.data.roles ?? {})]);
  return [...names].map((n) => roleInfo(n, global, project));
}

function roleInfo(name: string, global: LoadedFile, project?: LoadedFile): RoleInfo {
  const g = global.data.roles?.[name];
  const p = project?.data.roles?.[name];
  if (!g && !p) throw new ConfigError(`роль "${name}" не описана ни в одном конфиге`);
  const kind = p?.kind ?? g?.kind;
  const access = p?.mcp_access ?? g?.mcp_access;
  if (!kind) throw new ConfigError(`роль "${name}": не задано поле kind`);
  if (!access) throw new ConfigError(`роль "${name}": не задано поле mcp_access`);
  return { name, title: p?.title ?? g?.title ?? name, kind, mcp_access: access };
}

function levelOf(obj: Level | undefined): Level {
  if (!obj) return {};
  const { model, effort, instructions, permissions, env } = obj;
  return { model, effort, instructions, permissions, env };
}

/** Builds cascade layers: global -> project -> role (global, project) -> module. */
export function buildLayers(target: ResolveTarget, global: LoadedFile, project?: LoadedFile): Layer[] {
  const layers: Layer[] = [{ source: SOURCE_GLOBAL, baseDir: global.baseDir, level: levelOf(global.data) }];
  if (project) layers.push({ source: SOURCE_PROJECT, baseDir: project.baseDir, level: levelOf(project.data) });
  const gRole = global.data.roles?.[target.role];
  if (gRole) layers.push({ source: `роль ${target.role} (${SOURCE_GLOBAL})`, baseDir: global.baseDir, level: levelOf(gRole) });
  const pRole = project?.data.roles?.[target.role];
  if (pRole && project) layers.push({ source: `роль ${target.role} (${SOURCE_PROJECT})`, baseDir: project.baseDir, level: levelOf(pRole) });
  if (target.module && project) {
    const m = project.data.modules?.[target.module];
    if (m) layers.push({ source: `модуль ${target.module}`, baseDir: project.baseDir, level: levelOf(m) });
  }
  return layers;
}

export function resolveSettings(global: LoadedFile, project?: LoadedFile): { settings: Settings; sources: SourceMap } {
  const pick = (d: ConfigFile) => Object.fromEntries(SETTINGS_KEYS.map((k) => [k, d[k]]).filter(([, v]) => v !== undefined));
  const { value, sources } = mergeSettings([
    { source: SOURCE_GLOBAL, value: pick(global.data) },
    { source: SOURCE_PROJECT, value: project ? pick(project.data) : undefined },
  ]);
  const missing = REQUIRED_SETTINGS.filter((k) => getPath(value, k) === undefined);
  if (missing.length) throw new ConfigError(`в конфигурации не заданы: ${missing.join(', ')}`);
  return { settings: value as unknown as Settings, sources };
}

export function resolveConfig(loc: ConfigLocation, target: ResolveTarget): EffectiveConfig {
  const { global, project } = loadFiles(loc);
  const role = roleInfo(target.role, global, project);
  const layers = buildLayers(target, global, project);
  const { settings, sources } = resolveSettings(global, project);
  return {
    role,
    level: resolveLevels(layers, readText),
    layers: layers.map((l) => ({ source: l.source })),
    settings,
    settingsSources: sources,
  };
}

/** Copies shipped defaults into the global dir without overwriting existing files. */
export function ensureGlobalDefaults(defaultsDir: string, globalDir: string): void {
  const copy = (from: string, to: string) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        copy(src, dst);
      } else if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
  };
  fs.mkdirSync(globalDir, { recursive: true });
  copy(defaultsDir, globalDir);
}
