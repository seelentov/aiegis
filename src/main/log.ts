import path from 'node:path';
import { format } from 'node:util';
import log4js from 'log4js';
import type { LogLevel } from '../shared/types';

export interface LoggingSettings {
  level: LogLevel;
  /** Levels of single categories; the others use `level`. */
  categories: Record<string, LogLevel>;
  stderr: boolean;
  file: { enabled: boolean; max_size_mb: number; backups: number };
}

const LAYOUT = { type: 'aiegis' };
const MASK = '***';

const secrets = new Set<string>();
/** Levels set at runtime: they win over the config until the process exits (SPEC §23). */
const overrides: { level?: LogLevel; categories: Record<string, LogLevel> } = { categories: {} };
let current: { settings: LoggingSettings; dir: string } | null = null;
let crashHook = false;

/** Text of a log line; values added with `addSecret` never reach an output. */
export function formatLine(time: Date, level: string, category: string, data: unknown[]): string {
  let text = format(...data);
  for (const s of secrets) text = text.replaceAll(s, MASK);
  return `${time.toISOString()} ${level} ${category} ${text}`;
}

log4js.addLayout('aiegis', () => (ev) => formatLine(ev.startTime, ev.level.levelStr, ev.categoryName, ev.data));

function apply(): void {
  const { settings, dir } = current!;
  const appenders: log4js.Configuration['appenders'] = {};
  if (settings.stderr) appenders.stderr = { type: 'stderr', layout: LAYOUT };
  if (settings.file.enabled) {
    appenders.file = {
      type: 'file',
      filename: path.join(dir, 'aiegis.log'),
      maxLogSize: settings.file.max_size_mb * 1024 * 1024,
      backups: settings.file.backups,
      layout: LAYOUT,
    };
  }
  const names = Object.keys(appenders);
  // log4js requires an appender even when nothing is written.
  if (!names.length) {
    log4js.configure({ appenders: { none: { type: 'stderr' } }, categories: { default: { appenders: ['none'], level: 'off' } } });
    return;
  }
  const levels = { ...settings.categories, ...overrides.categories };
  log4js.configure({
    appenders,
    categories: {
      default: { appenders: names, level: overrides.level ?? settings.level },
      ...Object.fromEntries(Object.entries(levels).map(([name, level]) => [name, { appenders: names, level }])),
    },
  });
}

/** Applies settings; loggers obtained earlier follow them. Before the first call nothing is logged. */
export function configureLogging(settings: LoggingSettings, dir: string): void {
  current = { settings, dir };
  apply();
  if (crashHook) return;
  crashHook = true;
  process.on('uncaughtExceptionMonitor', (e, origin) => log4js.getLogger('core').error('%s: %s', origin, e.stack ?? e));
}

/** Changes a level until the process exits: of one category, or the default one. */
export function setLogLevel(level: LogLevel, category?: string): void {
  if (category) overrides.categories[category] = level;
  else overrides.level = level;
  if (current) apply();
}

export const getLogger = (category: string): log4js.Logger => log4js.getLogger(category);

export const addSecret = (value: string): void => void secrets.add(value);
export const removeSecret = (value: string): void => void secrets.delete(value);

/** Flushes the outputs. */
export function shutdownLogging(): Promise<void> {
  return new Promise((resolve) => log4js.shutdown(() => resolve()));
}
