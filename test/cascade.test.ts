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
  resolveSettings,
  scannerSettings,
  loadConfigFile,
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
    expect(() => parseConfigText('a: [', 'x.yaml')).toThrow(/x\.yaml: YAML error/);
    expect(() => parseConfigText('queue: { parallelism: 0 }', 'x.yaml')).toThrow(/queue\.parallelism/);
  });

  it('shipped defaults are valid and resolve for every role', () => {
    const g = tmpDir();
    ensureGlobalDefaults(DEFAULTS_DIR, g);
    const roles = listRoles({ globalDir: g });
    expect(roles.map((r) => r.name)).toEqual(expect.arrayContaining(['assistant', 'task', 'modules', 'matrix', 'sca', 'entry-points', 'tester']));
    for (const r of roles) {
      const cfg = resolveConfig({ globalDir: g }, { role: r.name });
      expect(cfg.level.model).toBeDefined();
      expect(cfg.level.instructions.length).toBeGreaterThan(0);
    }
    const task = resolveConfig({ globalDir: g }, { role: 'task' });
    expect(task.level.model).toEqual({ value: 'haiku', source: 'role task (global)' });
    expect(effectiveAllow(task.level)).not.toContain('Edit');
  });

  it('ensureGlobalDefaults updates untouched default files and reports edited ones once', () => {
    const defaults = tmpDir();
    const g = tmpDir();
    write(path.join(defaults, 'config.yaml'), 'model: m\n');
    write(path.join(defaults, 'a.md'), 'a1');
    write(path.join(defaults, 'b.md'), 'b1');
    expect(ensureGlobalDefaults(defaults, g)).toEqual({ added: [], updated: [], outdated: [] });
    write(path.join(g, 'b.md'), 'mine');
    write(path.join(defaults, 'a.md'), 'a2');
    write(path.join(defaults, 'b.md'), 'b2');
    expect(ensureGlobalDefaults(defaults, g)).toEqual({ added: [], updated: ['a.md'], outdated: ['b.md'] });
    expect(fs.readFileSync(path.join(g, 'a.md'), 'utf8')).toBe('a2');
    expect(fs.readFileSync(path.join(g, 'b.md'), 'utf8')).toBe('mine');
    expect(ensureGlobalDefaults(defaults, g)).toEqual({ added: [], updated: [], outdated: [] });
  });

  it('ensureGlobalDefaults never overwrites user values, only adds missing keys and roles/tasks entries', () => {
    const g = tmpDir();
    const file = path.join(g, 'config.yaml');
    write(file, '# mine\nmodel: mine\nroles:\n  task: { model: custom } # keep\n');
    write(path.join(g, 'instructions/roles/task.md'), 'my task prompt');
    const { added } = ensureGlobalDefaults(DEFAULTS_DIR, g);
    expect(added).toEqual(expect.arrayContaining(['tasks', 'queue', 'roles.modules', 'roles.entry-points']));
    expect(added).not.toContain('model');
    expect(added).not.toContain('roles.task');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain('# keep');
    const cfg = parseConfigText(text, file);
    expect(cfg.model).toBe('mine');
    expect(cfg.roles!.task).toEqual({ model: 'custom' });
    expect(cfg.tasks!.modules.role).toBe('modules');
    expect(fs.readFileSync(path.join(g, 'instructions/roles/task.md'), 'utf8')).toBe('my task prompt');
    expect(fs.existsSync(path.join(g, 'instructions/tasks/entry-points.md'))).toBe(true);
    expect(ensureGlobalDefaults(DEFAULTS_DIR, g).added).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
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
      'global',
      'project',
      'role task (global)',
      'role task (project)',
      'module auth',
    ]);
    expect(cfg.level.model).toEqual({ value: 'module-model', source: 'module auth' });
    expect(cfg.level.effort).toEqual({ value: 'high', source: 'role task (project)' });
    expect(cfg.level.instructions.map((i) => i.source)).toEqual(['project', 'role task (global)']);
    expect(effectiveAllow(cfg.level)).not.toContain('Grep');
    expect(cfg.settings.queue.parallelism).toBe(5);
    expect(cfg.settingsSources['queue.parallelism']).toBe('project');
    expect(cfg.settingsSources['limits.max_tokens_per_run']).toBe('global');
  });

  it('scanners: shipped set, project overrides per leaf, missing fields fail loudly, new scanners are merged in', () => {
    const g = tmpDir();
    const repo = tmpDir();
    ensureGlobalDefaults(DEFAULTS_DIR, g);
    write(path.join(repo, '.aiegis/config.yaml'), 'scanners: { trivy: { enabled: false }, custom: { binary: x } }\nsignals: { max_per_call: 7 }\n');
    const { settings, sources } = resolveSettings(loadConfigFile(path.join(g, 'config.yaml')), loadConfigFile(path.join(repo, '.aiegis/config.yaml')));
    expect(Object.keys(settings.scanners)).toEqual(['semgrep', 'gitleaks', 'trivy', 'custom']);
    expect(scannerSettings(settings, 'semgrep')).toMatchObject({ enabled: true, binary: 'semgrep', format: 'semgrep' });
    expect(scannerSettings(settings, 'trivy').enabled).toBe(false);
    expect(sources['scanners.trivy.enabled']).toBe('project');
    expect(settings.signals).toMatchObject({ max_per_call: 7, exclude_kinds: ['vuln'], auto_scan: true });
    expect(settings.suppressions).toEqual({ few_shot_limit: 5, apply_stale: false });
    expect(() => scannerSettings(settings, 'custom')).toThrow(/scanners\.custom\.format/);
    expect(() => scannerSettings(settings, 'nope')).toThrow(/is not configured/);

    const old = tmpDir();
    write(path.join(old, 'config.yaml'), 'scanners:\n  semgrep: { enabled: false }\n');
    expect(ensureGlobalDefaults(DEFAULTS_DIR, old).added).toEqual(expect.arrayContaining(['scanners.gitleaks', 'scanners.trivy', 'signals', 'suppressions']));
    expect(parseConfigText(fs.readFileSync(path.join(old, 'config.yaml'), 'utf8'), 'x').scanners!.semgrep).toEqual({ enabled: false });
  });

  it('fails loudly when required settings or roles are missing', () => {
    const g = tmpDir();
    write(path.join(g, 'config.yaml'), 'roles: { r: { kind: background, mcp_access: scoped } }\n');
    expect(() => resolveConfig({ globalDir: g }, { role: 'r' })).toThrow(ConfigError);
    expect(() => resolveConfig({ globalDir: g }, { role: 'r' })).toThrow(/queue\.parallelism/);
    expect(() => resolveConfig({ globalDir: g }, { role: 'nope' })).toThrow(/is not defined/);
  });
});
