import { describe, expect, it } from 'vitest';
import { rankHits } from '../src/main/search';
import type { SearchHit } from '../src/shared/types';

const hit = (id: string, title: string, extra: Partial<SearchHit> = {}): SearchHit => ({ kind: 'finding', id, title, detail: '', ...extra });

describe('search everywhere ranking', () => {
  const hits = [
    hit('f-3', 'Token leak in logs', { detail: 'high, open' }),
    hit('f-2', 'SQL injection in /orders', { location: { file: 'svc/OrderRepo.java', line: 42 } }),
    hit('sql', 'Raw query'),
    hit('f-1', 'Orders: SQL built by concatenation'),
  ];

  it('needs every word, anywhere: id, title, detail or file:line', () => {
    expect(rankHits(hits, 'orderrepo.java:42', 10).map((h) => h.id)).toEqual(['f-2']);
    expect(rankHits(hits, 'HIGH open', 10).map((h) => h.id)).toEqual(['f-3']);
    expect(rankHits(hits, 'sql missing', 10)).toEqual([]);
    expect(rankHits(hits, '   ', 10)).toEqual([]);
  });

  it('puts the id first, then a title prefix, then the phrase in the title, keeping the given order within a rank', () => {
    expect(rankHits(hits, 'sql', 10).map((h) => h.id)).toEqual(['sql', 'f-2', 'f-1']);
    expect(rankHits(hits, 'f-', 10).map((h) => h.id)).toEqual(['f-3', 'f-2', 'f-1']);
    expect(rankHits(hits, 'sql', 2)).toHaveLength(2);
  });
});
