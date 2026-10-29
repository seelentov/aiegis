import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigFileSchema, SETTINGS_KEYS, type ConfigFile, type Level } from './schema';
import type { PocAccount } from '../poc';
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
  matrix: {
    batch_size: number;
    triage_batch_size: number;
    estimate_history_runs: number;
    estimate_tokens_per_cell: { triage: number; verdicts: number };
  };
  findings: { similar_limit: number };
  tasks: Record<string, TaskSettings>;
  /** Scanners by name; entries are validated when used (`scannerSettings`). */
  scanners: Record<string, Partial<ScannerSettings>>;
  signals: {
    auto_scan: boolean;
    max_per_call: number;
    exclude_kinds: string[];
    requirements: Record<string, { kinds?: string[]; cwe?: string[]; rules?: string[] }>;
  };
  suppressions: { few_shot_limit: number; apply_stale: boolean };
  sca: {
    estimate_history_runs: number;
    estimate_tokens_per_package: number;
    scanner_hints_limit: number;
    prefilter_max_file_kb: number;
    report_max_mb: number;
  };
  poc: {
    start_timeout_sec: number;
    healthcheck_interval_sec: number;
    stop_timeout_sec: number;
    /** The only variables of the app's environment the tester session and the instance inherit. */
    env_passthrough: string[];
    /** Claude Code settings (`--settings`) of tester sessions: the OS sandbox. */
    claude_settings: Record<string, unknown>;
    /** Test environment (project config); without it the tester is unavailable. */
    environment?: { start?: string; healthcheck?: string; stop?: string; base_url?: string; accounts?: Record<string, PocAccount> };
  };
}

export interface ScannerSettings {
  enabled: boolean;
  binary: string;
  format: string;
  version_args: string[];
  args: string[];
  ok_exit_codes: number[];
  timeout_sec: number;
}

const SCANNER_KEYS: (keyof ScannerSettings)[] = ['enabled', 'binary', 'format', 'version_args', 'args', 'ok_exit_codes', 'timeout_sec'];

/** A configured scanner with every field set; a missing field is a configuration error. */
export function scannerSettings(settings: Settings, name: string): ScannerSettings {
  const s = settings.scanners[name];
  if (!s) throw new ConfigError(`сканер scanners.${name} не описан в конфигурации`);
  const missing = SCANNER_KEYS.filter((k) => s[k] === undefined);
  if (missing.length) throw new ConfigError(`в конфигурации не заданы: ${missing.map((k) => `scanners.${name}.${k}`).join(', ')}`);
  return s as ScannerSettings;
}

/** App-started task kinds that must be configured. */
export const TASK_KINDS = ['modules', 'entry_points', 'requirements', 'matrix_triage', 'matrix_verdicts', 'fix', 'sca_inventory', 'sca_reachability', 'poc'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface TaskSettings {
  role: string;
  title: string;
  prompt: string;
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
  /** Matrix name (`matrices.<name>`). */
  matrix?: string;
  /** Requirement key (`requirements.<key>`). */
  item?: string;
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
  'matrix.batch_size',
  'matrix.triage_batch_size',
  'matrix.estimate_history_runs',
  'matrix.estimate_tokens_per_cell.triage',
  'matrix.estimate_tokens_per_cell.verdicts',
  'findings.similar_limit',
  'scanners',
  'signals.auto_scan',
  'signals.max_per_call',
  'signals.exclude_kinds',
  'signals.requirements',
  'suppressions.few_shot_limit',
  'suppressions.apply_stale',
  'sca.estimate_history_runs',
  'sca.estimate_tokens_per_package',
  'sca.scanner_hints_limit',
  'sca.prefilter_max_file_kb',
  'sca.report_max_mb',
  'poc.start_timeout_sec',
  'poc.healthcheck_interval_sec',
  'poc.stop_timeout_sec',
  'poc.env_passthrough',
  'poc.claude_settings',
  ...TASK_KINDS.flatMap((t) => ['role', 'title', 'prompt'].map((k) => `tasks.${t}.${k}`)),
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

/** Builds cascade layers: global -> project -> role (global, project) -> module -> matrix -> requirement. */
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
  if (target.matrix && project) {
    const m = project.data.matrices?.[target.matrix];
    if (m) layers.push({ source: `матрица ${target.matrix}`, baseDir: project.baseDir, level: levelOf(m) });
  }
  if (target.item && project) {
    const r = project.data.requirements?.[target.item];
    if (r) layers.push({ source: `пункт ${target.item}`, baseDir: project.baseDir, level: levelOf(r) });
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

/** Maps whose entries are added one by one when a newer app version ships new ones. */
const MERGED_MAPS = ['roles', 'tasks', 'scanners'];

/**
 * Adds keys that a newer default config has and the user's config lacks: missing top-level keys and missing
 * entries of `roles`/`tasks`/`scanners`. Existing values are never changed; comments are preserved. Returns added paths.
 */
export function addMissingDefaults(userText: string, defaultsText: string): { text: string; added: string[] } {
  const doc = YAML.parseDocument(userText);
  const defaults = (YAML.parse(defaultsText) ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (!doc.has(key)) {
      doc.set(key, value);
      added.push(key);
    } else if (MERGED_MAPS.includes(key) && value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) {
        if (!doc.hasIn([key, name])) {
          doc.setIn([key, name], entry);
          added.push(`${key}.${name}`);
        }
      }
    }
  }
  return { text: added.length ? doc.toString() : userText, added };
}

/** Shipped-default hashes from the last sync, to tell untouched files from user edits. */
const DEFAULTS_MANIFEST = '.defaults.json';

export interface DefaultsSync {
  /** config.yaml paths added from the defaults. */
  added: string[];
  /** Files replaced with a newer default (the user had not edited them). */
  updated: string[];
  /** Files the user edited while the default changed: to be merged by hand. */
  outdated: string[];
}

/**
 * Copies shipped defaults into the global dir; config.yaml gets new keys only. A file whose default changed is
 * replaced only when it still equals the default recorded at the last sync; otherwise it is reported once as outdated.
 */
export function ensureGlobalDefaults(defaultsDir: string, globalDir: string): DefaultsSync {
  const cfg = globalConfigPath(globalDir);
  const sync: DefaultsSync = { added: [], updated: [], outdated: [] };
  if (fs.existsSync(cfg)) {
    const r = addMissingDefaults(fs.readFileSync(cfg, 'utf8'), fs.readFileSync(globalConfigPath(defaultsDir), 'utf8'));
    if (r.added.length) fs.writeFileSync(cfg, r.text);
    sync.added = r.added;
  }
  const manifestFile = path.join(globalDir, DEFAULTS_MANIFEST);
  let manifest: Record<string, string> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, string>;
  } catch {
    // first sync or unreadable manifest: every differing file counts as edited
  }
  const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const copy = (from: string, to: string) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        copy(src, dst);
        continue;
      }
      const rel = path.relative(defaultsDir, src).split(path.sep).join('/');
      const shipped = hash(src);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      } else if (rel !== 'config.yaml' && manifest[rel] !== shipped) {
        const current = hash(dst);
        if (current === manifest[rel]) {
          fs.copyFileSync(src, dst);
          sync.updated.push(rel);
        } else if (current !== shipped) {
          sync.outdated.push(rel);
        }
      }
      manifest[rel] = shipped;
    }
  };
  fs.mkdirSync(globalDir, { recursive: true });
  copy(defaultsDir, globalDir);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return sync;
}
