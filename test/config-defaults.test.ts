import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { addMissingDefaults } from '../src/main/config/loader';

describe('addMissingDefaults', () => {
  it('adds new keys of an existing matrix section and keeps the user values', () => {
    const { text, added } = addMissingDefaults('matrix:\n  batch_size: 6\n', 'matrix:\n  batch_size: 8\n  economy_batch_size: 100\n');
    expect(added).toEqual(['matrix.economy_batch_size']);
    expect(YAML.parse(text)).toEqual({ matrix: { batch_size: 6, economy_batch_size: 100 } });
  });
});
