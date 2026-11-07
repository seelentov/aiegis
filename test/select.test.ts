import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { matchOptions, optionsOf, stepOption } from '../src/renderer/ui/Select';

const opt = (label: string, disabled?: boolean) => ({ value: label, label, disabled });

describe('select options', () => {
  it('reads options and groups as a native select does', () => {
    const children = [
      h('option', { key: 'e', value: '' }),
      h('option', { key: 'n' }, 'no value'),
      false,
      h('option', { key: 'm', value: 'a' }, 'sha', ' ', 1),
      h('optgroup', { key: 'g', label: 'Sets' }, [h('option', { key: 's', value: 's', disabled: true }, 'set')]),
    ];
    expect(optionsOf(children)).toEqual([
      { value: '', label: '', group: undefined, disabled: undefined },
      { value: 'no value', label: 'no value', group: undefined, disabled: undefined },
      { value: 'a', label: 'sha 1', group: undefined, disabled: undefined },
      { value: 's', label: 'set', group: 'Sets', disabled: true },
    ]);
  });

  it('matches every word of the query in any order, ignoring case', () => {
    const list = [opt('main'), opt('fix/OAuth-token'), opt('feature/token')];
    expect(matchOptions(list, 'TOKEN fix').map((o) => o.label)).toEqual(['fix/OAuth-token']);
    expect(matchOptions(list, '  ')).toEqual(list);
    expect(matchOptions(list, 'absent')).toEqual([]);
  });

  it('skips disabled options and stops at the ends', () => {
    const list = [opt('a'), opt('b', true), opt('c')];
    expect(stepOption(list, 0, 1)).toBe(2);
    expect(stepOption(list, 2, -1)).toBe(0);
    expect(stepOption(list, 2, 1)).toBe(2);
    expect(stepOption(list, -1, 1)).toBe(0);
    expect(stepOption([], -1, 1)).toBe(-1);
  });
});
