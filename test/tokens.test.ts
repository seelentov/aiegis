import { describe, expect, it } from 'vitest';
import { authorize, TokenRegistry, type Grant } from '../src/main/mcp/tokens';

const base: Grant = {
  token: 't',
  projectId: 'p1',
  role: 'task',
  access: 'scoped',
  sessionId: 's',
  runId: 'r',
  scope: [{ type: 'task', id: 'j1' }],
};

describe('authorize', () => {
  it('scoped token: reads own project, writes only its scope, cannot manage', () => {
    expect(authorize(base, 'p1', { kind: 'read' }).ok).toBe(true);
    expect(authorize(base, 'p1', { kind: 'write', entity: { type: 'task', id: 'j1' } }).ok).toBe(true);
    expect(authorize(base, 'p1', { kind: 'write', entity: { type: 'task', id: 'j2' } }).ok).toBe(false);
    expect(authorize(base, 'p1', { kind: 'write', entity: { type: 'cell', id: 'j1' } }).ok).toBe(false);
    expect(authorize(base, 'p1', { kind: 'manage' }).ok).toBe(false);
  });

  it('manage token can manage but writes are still limited by scope', () => {
    const g: Grant = { ...base, access: 'manage', scope: [] };
    expect(authorize(g, 'p1', { kind: 'manage' }).ok).toBe(true);
    expect(authorize(g, 'p1', { kind: 'read' }).ok).toBe(true);
    expect(authorize(g, 'p1', { kind: 'write', entity: { type: 'task', id: 'j1' } }).ok).toBe(false);
  });

  it('never crosses projects', () => {
    const g: Grant = { ...base, access: 'manage' };
    for (const a of [{ kind: 'read' }, { kind: 'manage' }, { kind: 'write', entity: { type: 'task', id: 'j1' } }] as const) {
      expect(authorize(g, 'p2', a).ok).toBe(false);
    }
  });
});

describe('TokenRegistry', () => {
  it('issues unique tokens, resolves bearer headers, revokes', () => {
    const reg = new TokenRegistry();
    const a = reg.issue({ ...base });
    const b = reg.issue({ ...base });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(reg.fromHeader(`Bearer ${a.token}`)?.runId).toBe('r');
    expect(reg.fromHeader(a.token)).toBeUndefined();
    expect(reg.fromHeader(undefined)).toBeUndefined();
    reg.revoke(a.token);
    expect(reg.fromHeader(`Bearer ${a.token}`)).toBeUndefined();
  });
});
