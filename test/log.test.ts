import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ensureGlobalDefaults, loadConfigFile, loggingSettings } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import { addSecret, configureLogging, formatLine, getLogger, removeSecret, setLogLevel, shutdownLogging, type LoggingSettings } from '../src/main/log';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const settings = (o: Partial<LoggingSettings> = {}): LoggingSettings => ({
  level: 'info',
  categories: {},
  stderr: false,
  file: { enabled: true, max_size_mb: 1, backups: 1 },
  ...o,
});

async function logged(dir: string): Promise<string> {
  await shutdownLogging();
  return fs.readFileSync(path.join(dir, 'aiegis.log'), 'utf8');
}

afterEach(() => shutdownLogging());

test('a line has time, level, category and the message', () => {
  expect(formatLine(new Date(0), 'INFO', 'queue', ['job %s', 'a1'])).toBe('1970-01-01T00:00:00.000Z INFO queue job a1');
});

test('secrets are masked until removed', () => {
  addSecret('abc123');
  expect(formatLine(new Date(0), 'ERROR', 'mcp', ['bad token abc123'])).toContain('bad token ***');
  removeSecret('abc123');
  expect(formatLine(new Date(0), 'ERROR', 'mcp', ['abc123'])).toContain('abc123');
});

test('levels: the default one, a category of its own, a logger created before configuration', async () => {
  const early = getLogger('early');
  const dir = tmpDir();
  configureLogging(settings({ categories: { queue: 'debug' } }), dir);
  early.info('early info');
  getLogger('queue').debug('queue debug');
  getLogger('mcp').debug('mcp debug');
  const text = await logged(dir);
  expect(text).toContain('early info');
  expect(text).toContain('queue debug');
  expect(text).not.toContain('mcp debug');
});

test('a runtime level wins over the config and survives re-applying it', async () => {
  const dir = tmpDir();
  configureLogging(settings(), dir);
  setLogLevel('debug', 'runtime');
  configureLogging(settings(), dir);
  getLogger('runtime').debug('runtime debug');
  expect(await logged(dir)).toContain('runtime debug');
});

test('with every output off nothing is written', async () => {
  const dir = tmpDir();
  configureLogging(settings({ file: { enabled: false, max_size_mb: 1, backups: 1 } }), dir);
  getLogger('core').error('lost');
  await shutdownLogging();
  expect(fs.existsSync(path.join(dir, 'aiegis.log'))).toBe(false);
});

test('Core applies the logging section at start and on a config write, and an older config gets it', async () => {
  const home = tmpDir();
  const data = tmpDir();
  const defaults = fs.readFileSync(path.join(DEFAULTS_DIR, 'config.yaml'), 'utf8');
  const quiet = defaults.replace('stderr: true', 'stderr: false');
  write(path.join(home, 'config.yaml'), quiet);
  const core = new Core({ globalDir: home, dataDir: data, defaultsDir: DEFAULTS_DIR }, { logging: true });
  await core.start();
  core.writeConfigFile(null, path.join(home, 'config.yaml'), quiet.replace('level: info', 'level: debug'));
  getLogger('core').debug('debug after the write');
  await core.shutdown();
  await shutdownLogging();
  const text = fs.readFileSync(path.join(data, 'logs', 'aiegis.log'), 'utf8');
  expect(text).toContain('INFO core starting');
  expect(text).toContain('debug after the write');

  const older = tmpDir();
  write(path.join(older, 'config.yaml'), 'ui:\n  language: en\n');
  ensureGlobalDefaults(DEFAULTS_DIR, older);
  expect(loggingSettings(loadConfigFile(path.join(older, 'config.yaml'))).level).toBe('info');

  // An incomplete section fails logging only, not the whole config.
  write(path.join(older, 'config.yaml'), 'logging:\n  level: debug\n');
  expect(() => loggingSettings(loadConfigFile(path.join(older, 'config.yaml')))).toThrow(/must be set/);
});
