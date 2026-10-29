import crypto from 'node:crypto';
import type { Module, RawFinding, Severity, Suppression, SuppressionState } from '../shared/types';
import { SEVERITIES } from '../shared/types';
import { matchesGlobs } from './matrix';

/** Job/entity type of a scanner run (id = `<scanner>@<sha>:<targets key>`). */
export const SCAN_ENTITY = 'scan';
/** Validity entity type of suppressions (SPEC §5). */
export const SUPPRESSION_VALIDITY = 'suppression';

/** Whole repository as a scan target. */
export const REPO_TARGET = '.';

const WILDCARD = /[*?[]/;

/** Paths a scanner must cover for module globs: the static prefix of every include glob ("." if it starts with a wildcard). */
export function globTargets(globs: string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    if (g.startsWith('!')) continue;
    const segs = g.replace(/\/+$/, '').split('/');
    const i = segs.findIndex((s) => WILDCARD.test(s));
    const prefix = (i < 0 ? segs : segs.slice(0, i)).join('/');
    out.push(prefix || REPO_TARGET);
  }
  return minimalTargets(out);
}

/** Sorted targets without duplicates and without paths nested in other targets. */
export function minimalTargets(targets: string[]): string[] {
  const t = [...new Set(targets.map((x) => x.replace(/\/+$/, '') || REPO_TARGET))].sort();
  if (t.includes(REPO_TARGET)) return [REPO_TARGET];
  return t.filter((x) => !t.some((y) => y !== x && x.startsWith(y + '/')));
}

/** Whether a scan of `scanned` paths covers every path of `needed`. */
export function covers(scanned: string[], needed: string[]): boolean {
  return needed.every((n) => scanned.some((s) => s === REPO_TARGET || n === s || n.startsWith(s + '/')));
}

export const targetsKey = (targets: string[]) => crypto.createHash('sha1').update(minimalTargets(targets).join('\0')).digest('hex').slice(0, 12);

export const scanEntityId = (scanner: string, sha: string, targets: string[]) => `${scanner}@${sha}:${targetsKey(targets)}`;

export const SEVERITY_RANK: Record<Severity, number> = Object.fromEntries(SEVERITIES.map((s, i) => [s, SEVERITIES.length - i])) as Record<Severity, number>;

/** Whether a suppression drops a signal; "requirement_module" applies only to a get_signals call for that cell. */
export function suppressionMatches(s: Suppression, f: Pick<RawFinding, 'scanner' | 'ruleId' | 'fingerprint' | 'file'>, cell?: { moduleId: string; requirementId?: string | null }): boolean {
  switch (s.scope) {
    case 'finding':
      return s.scanner === f.scanner && s.fingerprint === f.fingerprint;
    case 'rule_glob':
      return s.scanner === f.scanner && s.ruleId === f.ruleId && matchesGlobs(f.file, s.globs);
    case 'requirement_module':
      return Boolean(cell?.requirementId && s.moduleId === cell.moduleId && s.requirementId === cell.requirementId);
  }
}

/** State of a suppression at a commit: revoked and expired win over validity (stale = touched code changed). */
export function suppressionState(s: Suppression, valid: boolean, today: string): SuppressionState {
  if (s.revokedAt) return 'revoked';
  if (s.expiresAt && s.expiresAt < today) return 'expired';
  return valid ? 'active' : 'stale';
}

/** Whether a suppression in `state` filters signals. */
export const suppressionApplies = (state: SuppressionState, applyStale: boolean) => state === 'active' || (applyStale && state === 'stale');

/** A suppression is relevant to a module's verdict session (few-shot) if it concerns the module's code or its cells. */
export function suppressionRelevant(s: Suppression, mod: Pick<Module, 'id' | 'globs'>, requirementIds: string[]): boolean {
  switch (s.scope) {
    case 'requirement_module':
      return s.moduleId === mod.id && Boolean(s.requirementId && requirementIds.includes(s.requirementId));
    case 'finding':
      return Boolean(s.file && matchesGlobs(s.file, mod.globs));
    case 'rule_glob':
      return s.touchedFiles.some((f) => matchesGlobs(f, mod.globs)) || covers(globTargets(s.globs), globTargets(mod.globs)) || covers(globTargets(mod.globs), globTargets(s.globs));
  }
}

/** Optional relevance of signals to a requirement (`signals.requirements.<key>`). */
export interface RequirementFilter {
  kinds?: string[];
  cwe?: string[];
  rules?: string[];
}

/** A signal passes a requirement filter if it matches any of its criteria (kinds, CWE, rule regexps). */
export function matchesRequirement(f: Pick<RawFinding, 'kind' | 'cwe' | 'ruleId'>, filter: RequirementFilter): boolean {
  const norm = (c: string) => c.toUpperCase().replace(/^CWE[-\s]?/, '');
  const cwe = new Set((filter.cwe ?? []).map(norm));
  if (filter.kinds?.includes(f.kind)) return true;
  if (f.cwe.some((c) => cwe.has(norm(c)))) return true;
  return (filter.rules ?? []).some((r) => {
    try {
      return new RegExp(r, 'i').test(f.ruleId);
    } catch {
      return false;
    }
  });
}

/** Human-readable scope of a suppression. */
export function suppressionLabel(s: Suppression, names: { module?: string | null; requirement?: string | null } = {}): string {
  switch (s.scope) {
    case 'finding':
      return `${s.scanner} ${s.ruleId} в ${s.file}${s.line ? `:${s.line}` : ''}`;
    case 'rule_glob':
      return `${s.scanner} ${s.ruleId} × ${s.globs.join(', ')}`;
    case 'requirement_module':
      return `пункт ${names.requirement ?? s.requirementId} × модуль ${names.module ?? s.moduleId}`;
  }
}

/** Arguments of MCP get_signals (SPEC §4, Q10). */
export interface SignalQuery {
  moduleId: string;
  requirementId?: string | null;
  /** Commit of the asking run; default: HEAD of the working copy. */
  commit?: string | null;
  kind?: string | null;
  scanner?: string | null;
  minSeverity?: Severity | null;
  filePrefix?: string | null;
  limit?: number | null;
}

/** One secret is often reported by several scanners: groups secret signals by file:line, other signals stay alone. */
export function groupSameSecret<T extends Pick<RawFinding, 'id' | 'kind' | 'file' | 'line'>>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const f of rows) {
    const key = f.kind === 'secret' && f.line !== null ? `secret ${f.file}:${f.line}` : `id ${f.id}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()];
}
