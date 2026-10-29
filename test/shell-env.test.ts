import { describe, expect, it } from 'vitest';
import { loginShellPath, mergePath, parseShellPath } from '../src/main/shell-env';

describe('login shell PATH for apps started outside a terminal', () => {
  it('shell PATH goes first, current entries are kept once, banners around the markers are ignored', () => {
    expect(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin::/sbin')).toBe('/opt/homebrew/bin:/usr/bin:/bin:/sbin');
    expect(mergePath('/a', undefined)).toBe('/a');
    expect(parseShellPath('Welcome!\n__AIEGIS_PATH__/opt/homebrew/bin:/usr/bin__AIEGIS_PATH__\nbye')).toBe('/opt/homebrew/bin:/usr/bin');
    expect(parseShellPath('no markers')).toBeNull();
    expect(parseShellPath('__AIEGIS_PATH____AIEGIS_PATH__')).toBeNull();
  });

  it('reads PATH from a real shell; a missing shell gives null', async () => {
    expect(await loginShellPath('/bin/sh')).toMatch(/\/bin/);
    expect(await loginShellPath('/no/such/shell')).toBeNull();
  });
});
