import crypto from 'node:crypto';
import type { Evidence, Finding, FindingInput, SimilarFinding } from '../shared/types';

/** Entity of a requirement extraction job (id = document version id). */
export const DOC_VERSION_ENTITY = 'doc_version';
/** Entity of a matrix cell (id = `<module_id>/<requirement_id>`). */
export const CELL_ENTITY = 'cell';
/** Entity of a matrix job covering several cells (id = `<stage>:<matrix>:<module>:<group>:<n>`). */
export const MATRIX_BATCH_ENTITY = 'matrix_batch';
/** Entity of a fix session (id = finding id). */
export const FINDING_ENTITY = 'finding';
/** Validity entity types (SPEC §5). */
export const VERDICT_VALIDITY = 'verdict';
export const SNAPSHOT_VALIDITY = 'ep_snapshot';

export interface CellRef {
  moduleId: string;
  requirementId: string;
}

export const cellId = (c: CellRef) => `${c.moduleId}/${c.requirementId}`;

export function parseCellId(id: string): CellRef {
  const i = id.indexOf('/');
  if (i <= 0) throw new Error(`invalid cell id ${id}`);
  return { moduleId: id.slice(0, i), requirementId: id.slice(i + 1) };
}

/** Whitespace-insensitive text identity of a requirement: a change of it makes verdicts stale. */
export function reqHash(text: string): string {
  return crypto.createHash('sha256').update(text.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
}

/**
 * Git pathspec glob (`:(glob)`) as a RegExp: `*` and `?` do not cross "/", `**` does, `[...]` is a class.
 * A pattern also matches everything below a matching directory, as git pathspecs do.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      re += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re.replace(/\/$/, '')}(?:/.*)?$`);
}

/** Module membership of a path by its globs (includes minus "!" excludes). */
export function matchesGlobs(file: string, globs: string[]): boolean {
  const inc = globs.filter((g) => !g.startsWith('!'));
  const exc = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  return inc.some((g) => globToRegExp(g).test(file)) && !exc.some((g) => globToRegExp(g).test(file));
}

/** Changed files that a verdict or snapshot depends on: its touched files or any file of the module. */
export function affectingChanges(changed: string[], touched: string[], globs: string[]): string[] {
  const t = new Set(touched);
  return changed.filter((f) => t.has(f) || (globs.length > 0 && matchesGlobs(f, globs)));
}

export interface BatchCell extends CellRef {
  group: string;
  /** Has its own cascade level (`requirements.<key>`): runs alone. */
  alone: boolean;
}

export interface Batch {
  moduleId: string;
  group: string;
  cells: CellRef[];
}

/**
 * Splits cells into sessions: one per module x group, at most `size` cells each (SPEC §4, Q8).
 * Cells with their own cascade level go into single-cell batches so their config applies fully.
 */
export function planBatches(cells: BatchCell[], size: number, byGroup = true): Batch[] {
  const groups = new Map<string, Batch>();
  const out: Batch[] = [];
  for (const c of cells) {
    const ref = { moduleId: c.moduleId, requirementId: c.requirementId };
    const group = byGroup ? c.group : '';
    if (c.alone) {
      out.push({ moduleId: c.moduleId, group, cells: [ref] });
      continue;
    }
    const k = `${c.moduleId}\0${group}`;
    let b = groups.get(k);
    if (!b || b.cells.length >= size) {
      b = { moduleId: c.moduleId, group, cells: [] };
      groups.set(k, b);
      out.push(b);
    }
    b.cells.push(ref);
  }
  return out;
}

const normCwe = (c: string | null | undefined) => (c ? c.toUpperCase().replace(/^CWE[-\s]?/, '') : '');
const fileSet = (files: Evidence[]) => new Set(files.map((f) => f.file));

/**
 * Candidates for deduplication (SPEC §4, Q23): same entry point, same CWE, overlapping files.
 * A candidate needs at least two of the signals, or the same entry point.
 */
export function rankSimilar(
  query: Pick<FindingInput, 'entryPoint' | 'files' | 'cwe' | 'moduleId'>,
  findings: Finding[],
  limit: number,
): SimilarFinding[] {
  const qFiles = fileSet(query.files);
  const out: SimilarFinding[] = [];
  for (const f of findings) {
    if (f.mergedInto) continue;
    const reasons: string[] = [];
    let score = 0;
    if (query.entryPoint && f.entryPoint && query.entryPoint.trim() === f.entryPoint.trim() && (!query.moduleId || !f.moduleId || query.moduleId === f.moduleId)) {
      score += 3;
      reasons.push('same entry point');
    }
    if (normCwe(query.cwe) && normCwe(query.cwe) === normCwe(f.cwe)) {
      score += 2;
      reasons.push(`same CWE-${normCwe(f.cwe)}`);
    }
    const shared = [...fileSet(f.files)].filter((x) => qFiles.has(x));
    if (shared.length) {
      score += Math.min(shared.length, 3);
      reasons.push(`shared files: ${shared.join(', ')}`);
    }
    if (score >= 3) out.push({ finding: f, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || b.finding.createdAt.localeCompare(a.finding.createdAt)).slice(0, limit);
}

/** Text normalized for quote checks: case, whitespace and markdown/typographic noise do not matter. */
export function normalizeForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”«»"'`]/g, '')
    .replace(/[*_#>|~\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether `quote` occurs in `text` (after normalization). */
export function quoteFound(text: string, quote: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length > 0 && normalizeForQuote(text).includes(q);
}
