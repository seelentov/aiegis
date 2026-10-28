import crypto from 'node:crypto';

export type Access = 'manage' | 'scoped';

export interface EntityRef {
  type: string;
  id: string;
}

/** What a run token allows (SPEC §1, Q25). */
export interface Grant {
  token: string;
  projectId: string;
  role: string;
  access: Access;
  sessionId: string;
  runId: string;
  /** Entities this token may write. */
  scope: EntityRef[];
}

export type Action = { kind: 'read' } | { kind: 'write'; entity: EntityRef } | { kind: 'manage' };

export type Decision = { ok: true } | { ok: false; reason: string };

/**
 * Pure authorization check.
 * - every token reads its own project only;
 * - writes are allowed only for entities in the token scope;
 * - management (enqueue/cancel jobs) requires access "manage".
 */
export function authorize(grant: Grant, projectId: string, action: Action): Decision {
  if (grant.projectId !== projectId) return { ok: false, reason: 'токен выдан для другого проекта' };
  switch (action.kind) {
    case 'read':
      return { ok: true };
    case 'manage':
      return grant.access === 'manage' ? { ok: true } : { ok: false, reason: `роль ${grant.role} не имеет прав управления` };
    case 'write': {
      const inScope = grant.scope.some((e) => e.type === action.entity.type && e.id === action.entity.id);
      return inScope
        ? { ok: true }
        : { ok: false, reason: `запись ${action.entity.type}:${action.entity.id} вне scope токена` };
    }
  }
}

export class TokenRegistry {
  private readonly grants = new Map<string, Grant>();

  issue(g: Omit<Grant, 'token'>): Grant {
    const grant: Grant = { ...g, token: crypto.randomBytes(32).toString('hex') };
    this.grants.set(grant.token, grant);
    return grant;
  }

  get(token: string): Grant | undefined {
    return this.grants.get(token);
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  /** Returns the grant for an `Authorization: Bearer <token>` header value. */
  fromHeader(header: string | undefined): Grant | undefined {
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(header ?? '');
    return m ? this.grants.get(m[1]) : undefined;
  }
}
