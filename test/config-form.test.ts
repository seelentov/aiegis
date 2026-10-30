import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { configSections, editYaml, hintOf } from '../src/renderer/components/ConfigForm';

const SRC = `# header
model: sonnet
queue:
  # parallel jobs
  parallelism: 2
  # pause
  pause_sec: 900 # inline
`;

describe('config form helpers', () => {
  it('reads key comments as hints, including the first key of a nested map', () => {
    const doc = YAML.parseDocument(SRC);
    expect(hintOf(doc, ['queue', 'parallelism'])).toBe('parallel jobs');
    expect(hintOf(doc, ['queue', 'pause_sec'])).toBe('pause');
    expect(hintOf(doc, ['missing'])).toBeUndefined();
    expect(hintOf(null, ['model'])).toBeUndefined();
  });

  it('sets and removes values keeping comments', () => {
    const set = editYaml(SRC, ['queue', 'pause_sec'], 60);
    expect(set).toContain('# pause');
    expect(set).toContain('pause_sec: 60 # inline');
    expect(YAML.parse(editYaml(set, ['queue', 'parallelism'], undefined)).queue).toEqual({ pause_sec: 60 });
  });

  it('creates nested keys in an empty project config', () => {
    expect(YAML.parse(editYaml('', ['limits', 'max_tokens_per_run'], 1000))).toEqual({ limits: { max_tokens_per_run: 1000 } });
  });

  it('lists plain values as one section and every map as its own, global keys first', () => {
    expect(configSections(SRC, 'modules:\n  auth: {}\nmodel: opus\n')).toEqual(['', 'queue', 'modules']);
    expect(configSections(null, 'a: [')).toEqual([]);
  });
});
