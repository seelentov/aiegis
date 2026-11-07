import { describe, expect, it } from 'vitest';
import { pageSlice } from '../src/renderer/ui/Pager';

const items = Array.from({ length: 5 }, (_, i) => i);

describe('pageSlice', () => {
  it('cuts the requested page', () => {
    expect(pageSlice(items, 1, 2)).toEqual({ rows: [0, 1], page: 1 });
    expect(pageSlice(items, 3, 2)).toEqual({ rows: [4], page: 3 });
  });

  it('falls back to the last page when the list shrinks', () => {
    expect(pageSlice(items, 9, 2)).toEqual({ rows: [4], page: 3 });
    expect(pageSlice(items.slice(0, 2), 3, 2)).toEqual({ rows: [0, 1], page: 1 });
  });

  it('keeps an empty list on page one', () => {
    expect(pageSlice([], 4, 2)).toEqual({ rows: [], page: 1 });
    expect(pageSlice(items, 0, 2).page).toBe(1);
  });
});
