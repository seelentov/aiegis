import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveAllow, joinInstructions, mergeSettings, resolveLevels, type Layer } from '../src/main/config/cascade';
import {
  ConfigError,
  ensureGlobalDefaults,
  listRoles,
  parseConfigText,
  resolveConfig,
} from '../src/main/config/loader';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const files: Record<string, string> = { '/g/a.md': 'GLOBAL', '/p/b.md': 'PROJECT', '/p/c.md': 'ROLE' };
const read = (f: string) => {
  if (!(f in files)) throw new Error('missing ' + f);
  return files[f];
};

describe('resolveLevels', () => {
  it('lower level replaces scalars and records the source', () => {
    const layers: Layer[] = [
      { source: 'g', baseDir: '/g', level: { model: 'sonnet', effort: 'low' } },
      { source: 'p', baseDir: '/p', level: { model: 'haiku' } },
    ];
    const r = resolveLevels(layers, read);
    expect(r.model).toEqual({ value: 'haiku', source: 'p' });
    expect(r.effort).toEqual({ value: 'low', source: 'g' });
  });

  it('concatenates instructions top-down, files relative to the layer dir', () => {
    const r = resolveLevels(
      [
        { source: 'g', baseDir: '/g', level: { instructions: { file: 'a.md' } } },
        { source: 'p', baseDir: '/p', level: { instructions: { file: ['b.md'], text: 'inline' } } },
      ],
      read,
    );
    expect(r.instructions.map((i) => [i.source, i.text])).toEqual([
      ['g', 'GLOBAL'],
      ['p', 'PROJECT'],
      ['p', 'inline'],
    ]);
    expect(joinInstructions(r)).toBe('GLOBAL\n\nPROJECT\n\ninline');
  });

  it('mode: replace drops instructions from upper levels', () => {
    const r = resolveLevels(
      [
        { source: 'g', baseDir: '/g', level: { instructions: 'upper' } },
        { source: 'r', baseDir: '/p', level: { instructions: { mode: 'replace', file: 'c.md' } } },
        { source: 'm', baseDir: '/p', level: { instructions: 'lower' } },
      ],
      read,
    );
    expect(r.instructions.map((i) => i.text)).toEqual(['ROLE', 'lower']);
  });

  it('unions permissions and deny wins', () => {
    const r = resolveLevels(
      [
        { source: 'g', baseDir: '/g', level: { permissions: { allow: ['Read', 'Edit'], deny: [] } } },
        { source: 'r', baseDir: '/g', level: { permissions: { allow: ['Read', 'Grep'], deny: ['Edit'] } } },
      ],
      read,
    );
    expect(r.permissions.allow.map((a) => a.value)).toEqual(['Read', 'Edit', 'Grep']);
    expect(r.permissions.allow[0].source).toBe('g');
    expect(effectiveAllow(r)).toEqual(['Read', 'Grep']);
    expect(r.permissions.deny).toEqual([{ value: 'Edit', source: 'r' }]);
  });

  it('merges env per key', () => {
    const r = resolveLevels(
      [
        { source: 'g', baseDir: '/', level: { env: { A: '1', B: '1' } } },
        { source: 'p', baseDir: '/', level: { env: { B: '2' } } },
      ],
      read,
    );
    expect(r.env).toEqual({ A: { value: '1', source: 'g' }, B: { value: '2', source: 'p' } });
  });
});

describe('mergeSettings', () => {
  it('deep-merges with per-leaf sources; arrays are leaves', () => {
    const { value, sources } = mergeSettings([
      { source: 'g', value: { queue: { parallelism: 2, x: 1 }, claude: { args: ['a', 'b'] } } },
      { source: 'p', value: { queue: { parallelism: 4 }, claude: { args: ['c'] } } },
    ]);
    expect(value).toEqual({ queue: { parallelism: 4, x: 1 }, claude: { args: ['c'] } });
    expect(sources).toEqual({ 'queue.parallelism': 'p', 'queue.x': 'g', 'claude.args': 'p' });
  });
});

describe('config files', () => {
  it('rejects invalid YAML and schema errors with the file name', () => {
    expect(() => parseConfigText('a: [', 'x.yaml')).toThrow(/x\.yaml: ошибка YAML/);
    expect(() => parseConfigText('queue: { parallelism: 0 }', 'x.yaml')).toThrow(/queue\.parallelism/);
  });

  it('shipped defaults are valid and resolve for every role', () => {
    const g = tmpDir();
    ensureGlobalDefaults(DEFAULTS_DIR, g);
    const roles = listRoles({ globalDir: g });
    expect(roles.map((r) => r.name)).toEqual(expect.arrayContaining(['assistant', 'task', 'matrix', 'sca', 'entry-points', 'tester']));
    for (const r of roles) {
      const cfg = resolveConfig({ globalDir: g }, { role: r.name });
      expect(cfg.level.model).toBeDefined();
      expect(cfg.level.instructions.length).toBeGreaterThan(0);
    }
    const task = resolveConfig({ globalDir: g }, { role: 'task' });
    expect(task.level.model).toEqual({ value: 'haiku', source: 'роль task (глобальный)' });
    expect(effectiveAllow(task.level)).not.toContain('Edit');
  });

  it('ensureGlobalDefaults never overwrites user files', () => {
    const g = tmpDir();
    write(path.join(g, 'config.yaml'), '# mine\n');
    ensureGlobalDefaults(DEFAULTS_DIR, g);
    expect(fs.readFileSync(path.join(g, 'config.yaml'), 'utf8')).toBe('# mine\n');
    expect(fs.existsSync(path.join(g, 'instructions/roles/task.md'))).toBe(true);
  });

  it('cascade order: global -> project -> role(global) -> role(project) -> module', () => {
    const g = tmpDir();
    const repo = tmpDir();
    ensureGlobalDefaults(DEFAULTS_DIR, g);
    write(
      path.join(repo, '.aiegis/config.yaml'),
      [
        'model: project-model',
        'instructions: { file: instructions/project.md }',
        'queue: { parallelism: 5 }',
        'roles:',
        '  task:',
        '    effort: high',
        '    permissions: { deny: [Grep] }',
        'modules:',
        '  auth:',
        '    model: module-model',
        '    env: { M: "1" }',
      ].join('\n'),
    );
    write(path.join(repo, '.aiegis/instructions/project.md'), 'PROJECT RULES');
    const cfg = resolveConfig({ globalDir: g, projectRoot: repo }, { role: 'task', module: 'auth' });
    expect(cfg.layers.map((l) => l.source)).toEqual([
      'глобальный',
      'проект',
      'роль task (глобальный)',
      'роль task (проект)',
      'модуль auth',
    ]);
    expect(cfg.level.model).toEqual({ value: 'module-model', source: 'модуль auth' });
    expect(cfg.level.effort).toEqual({ value: 'high', source: 'роль task (проект)' });
    expect(cfg.level.instructions.map((i) => i.source)).toEqual(['проект', 'роль task (глобальный)']);
    expect(effectiveAllow(cfg.level)).not.toContain('Grep');
    expect(cfg.settings.queue.parallelism).toBe(5);
    expect(cfg.settingsSources['queue.parallelism']).toBe('проект');
    expect(cfg.settingsSources['limits.max_tokens_per_run']).toBe('глобальный');
  });

  it('fails loudly when required settings or roles are missing', () => {
    const g = tmpDir();
    write(path.join(g, 'config.yaml'), 'roles: { r: { kind: background, mcp_access: scoped } }\n');
    expect(() => resolveConfig({ globalDir: g }, { role: 'r' })).toThrow(ConfigError);
    expect(() => resolveConfig({ globalDir: g }, { role: 'r' })).toThrow(/queue\.parallelism/);
    expect(() => resolveConfig({ globalDir: g }, { role: 'nope' })).toThrow(/не описана/);
  });
});
