import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RU } from '../src/renderer/i18n-ru';

const dir = path.join(__dirname, '../src/renderer');
const sources = fs
  .readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('i18n'))
  .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));

describe('ui texts', () => {
  it('every tr() source has a Russian translation', () => {
    const keys = sources.flatMap((s) => [...s.matchAll(/\btr\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1')));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !(k in RU))).toEqual([]);
  });

  it('keeps the placeholders of the source', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(Object.entries(RU).filter(([en, ru]) => names(en).join() !== names(ru).join())).toEqual([]);
  });

  it('leaves no Russian text outside the dictionary', () => {
    expect(sources.filter((s) => /[А-Яа-яЁё]/.test(s))).toEqual([]);
  });
});
