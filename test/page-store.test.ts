import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { ProjectStore } from '../src/main/store';

let store: ProjectStore;

beforeEach(() => {
  store = new ProjectStore('p', openDb(':memory:'));
  for (let i = 1; i <= 7; i++) {
    store.addJob({ type: 'task', role: i % 2 ? 'odd' : 'even', title: i === 3 ? '100%_done' : `job ${i}`, entityType: 'task', entityId: `e${i}`, payload: {} });
  }
});

const titles = (q: Parameters<ProjectStore['pageJobs']>[0]) => store.pageJobs(q).rows.map((j) => j.title);

describe('pages of a list', () => {
  it('serves the newest first and reaches past any window', () => {
    const p = store.pageJobs({ limit: 3, offset: 3 });
    expect(p).toMatchObject({ total: 7, all: 7, offset: 3 });
    expect(p.rows.map((j) => j.title)).toEqual(['job 4', '100%_done', 'job 2']);
  });

  it('serves the last page for an offset past the end', () => {
    const p = store.pageJobs({ limit: 3, offset: 300 });
    expect(p.offset).toBe(6);
    expect(p.rows).toHaveLength(1);
  });

  it('filters before paging and counts what passed', () => {
    const p = store.pageJobs({ limit: 2, filters: { role: 'even' } });
    expect(p).toMatchObject({ total: 3, all: 7 });
    expect(p.options.role).toEqual(['even', 'odd']);
  });

  it('takes wildcards in a text filter literally', () => {
    expect(titles({ limit: 9, filters: { title: '%' } })).toEqual(['100%_done']);
    expect(titles({ limit: 9, filters: { title: '_' } })).toEqual(['100%_done']);
    expect(titles({ limit: 9, filters: { title: 'JOB 7' } })).toEqual(['job 7']);
  });

  it('ignores case in any alphabet, for filters and sorting', () => {
    for (const title of ['Проверка Ёлки', 'яблоко', 'Арбуз']) store.addJob({ type: 'task', role: 'r', title, entityType: 'task', entityId: title, payload: {} });
    expect(titles({ limit: 9, filters: { title: 'проверка ёл' } })).toEqual(['Проверка Ёлки']);
    expect(titles({ limit: 9, filters: { title: 'ЯБЛОКО' } })).toEqual(['яблоко']);
    const cyrillic = store.pageJobs({ limit: 20, sort: { key: 'title', dir: 1 } }).rows.map((j) => j.title).filter((t) => /[а-я]/i.test(t));
    expect(cyrillic).toEqual(['Арбуз', 'Проверка Ёлки', 'яблоко']);
  });

  it('sorts the whole list', () => {
    expect(titles({ limit: 1, sort: { key: 'title', dir: 1 } })).toEqual(['100%_done']);
    expect(titles({ limit: 1, sort: { key: 'title', dir: -1 } })).toEqual(['job 7']);
  });

  it('rejects what is not a known column or a valid window', () => {
    expect(() => store.pageJobs({ limit: 1, sort: { key: 'id; DROP TABLE jobs', dir: 1 } })).toThrow(/unknown column/);
    expect(() => store.pageJobs({ limit: 1, filters: { payload: 'x' } })).toThrow(/unknown column/);
    expect(() => store.pageJobs({ limit: 1, filters: { constructor: 'x' } })).toThrow(/unknown column/);
    expect(() => store.pageRuns({ limit: 1, filters: { cost: '1' } })).toThrow(/cannot be filtered/);
    expect(() => store.pageJobs({ limit: 0 })).toThrow(/limit/);
    expect(() => store.pageJobs({ limit: 1, offset: -1 })).toThrow(/offset/);
  });

  it('serves an empty list', () => {
    expect(store.pageRuns({ limit: 5, offset: 10 })).toMatchObject({ rows: [], total: 0, all: 0, offset: 0 });
  });
});

describe('details panel', () => {
  it('starts anew for each item, so actions never go to an item other than the one shown', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/components/DetailsPanel.tsx'), 'utf8');
    const views = [...source.matchAll(/<(\w+Details(?:View)?)\b([^>]*)>/g)];
    expect(views.length).toBeGreaterThanOrEqual(9);
    expect(views.filter((m) => !m[2].includes('key=')).map((m) => m[1])).toEqual([]);
  });
});

describe('tables of the renderer', () => {
  it('all go through a grid', () => {
    const dir = path.join(__dirname, '../src/renderer/components');
    const bare = fs.readdirSync(dir).flatMap((f) => {
      const source = fs.readFileSync(path.join(dir, f), 'utf8');
      return [...source.matchAll(/<Table\b[^>]*>(?!\s*\{\w+\.head\})/g)].map(() => f);
    });
    expect(bare).toEqual([]);
  });

  it('show a pager wherever they show a page of rows', () => {
    const dir = path.join(__dirname, '../src/renderer/components');
    const cut = fs.readdirSync(dir).filter((f) => f !== 'Grid.tsx').flatMap((f) =>
      fs.readFileSync(path.join(dir, f), 'utf8').split(/\n(?=(?:export )?function )/).flatMap((part) =>
        [...part.matchAll(/const (\w+) = use(?:Server)?Grid/g)].map((m) => m[1]).filter((v) => part.includes(`${v}.rows`) && !part.includes(`{${v}.pager}`)).map((v) => `${f}: ${v}`),
      ),
    );
    expect(cut).toEqual([]);
  });
});
