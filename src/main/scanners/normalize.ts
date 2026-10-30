import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Severity, SignalKind } from '../../shared/types';

/** A scanner result in the common shape of `raw_findings` (SPEC §4, Q10). */
export interface NormalizedFinding {
  kind: SignalKind;
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  /** Relative to the repository root. */
  file: string;
  line: number | null;
  endLine: number | null;
  cwe: string[];
  tags: string[];
  fingerprint: string;
  snippet: string | null;
  data: Record<string, unknown>;
}

export interface NormalizeContext {
  /** Absolute root of the scanned checkout (absolute reported paths are made relative to it). */
  root: string;
  /** Path the invocation scanned ("." or a directory/file relative to the repository root). */
  target: string;
  /** Whether a path relative to the repository root exists in the scanned checkout. */
  exists: (rel: string) => boolean;
  /** Arguments of the invocation (normalizers may need the tool's options). */
  args?: string[];
  /** Reports a non-fatal problem of the scan (e.g. files the tool could not parse). */
  warn?: (message: string) => void;
}

export type Normalizer = (output: string, ctx: NormalizeContext) => NormalizedFinding[];

type Obj = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

export const hash = (...parts: unknown[]): string =>
  crypto.createHash('sha256').update(parts.map((p) => str(p)).join('\0')).digest('hex').slice(0, 20);

/** Reported path -> path relative to the repository root (tools report paths relative to cwd or to the target). */
export function repoPath(reported: string, ctx: NormalizeContext): string {
  let p = reported.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(p)) return path.relative(ctx.root, p).split(path.sep).join('/');
  const t = ctx.target.replace(/\/+$/, '').replace(/^\.\//, '');
  if (!t || t === '.') return p;
  const joined = path.posix.join(t, p);
  if (ctx.exists(p) && !ctx.exists(joined)) return p;
  if (ctx.exists(joined)) return joined;
  // Neither exists (deleted file, odd report): a path already under the target is kept.
  return p === t || p.startsWith(t + '/') ? p : joined;
}

/** CWE ids from strings like "CWE-89: Improper Neutralization ..." or "CWE-89". */
export function cweIds(values: unknown): string[] {
  const out = new Set<string>();
  for (const v of Array.isArray(values) ? values : values ? [values] : []) {
    const m = /CWE[-\s]?(\d+)/i.exec(str(v));
    if (m) out.add(`CWE-${m[1]}`);
  }
  return [...out];
}

const SEVERITY_WORDS: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  ERROR: 'high',
  MEDIUM: 'medium',
  MODERATE: 'medium',
  WARNING: 'medium',
  LOW: 'low',
  INFO: 'low',
  NOTE: 'info',
  UNKNOWN: 'info',
};

export function severityOf(v: unknown, fallback: Severity = 'info'): Severity {
  return SEVERITY_WORDS[str(v).toUpperCase()] ?? fallback;
}

/** Makes fingerprints unique within one output (identical matches in one file get an occurrence index). */
function dedupeFingerprints(rows: NormalizedFinding[]): NormalizedFinding[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const n = seen.get(r.fingerprint) ?? 0;
    seen.set(r.fingerprint, n + 1);
    return n ? { ...r, fingerprint: `${r.fingerprint}#${n}` } : r;
  });
}

function parseJson(output: string, tool: string): unknown {
  const text = output.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${tool}: output is not JSON (${(e as Error).message})`);
  }
}

const CONFIG_FLAGS = ['--config', '-c', '-f'];

/**
 * Semgrep prefixes ids of rules from local files with the rule file's directory as given (`/a/.b/c.yaml` -> `a.b.`).
 * For absolute paths that prefix changes with the location (temp dirs, worktrees named by commit), so it is cut off:
 * rule ids and fingerprints then do not depend on where the rules live. Relative paths give stable prefixes and stay.
 */
export function semgrepRulePrefixes(args: string[], isDir: (p: string) => boolean = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false): string[] {
  const values: string[] = [];
  args.forEach((a, i) => {
    if (CONFIG_FLAGS.includes(a) && args[i + 1] !== undefined) values.push(args[i + 1]);
    else if (a.startsWith('--config=')) values.push(a.slice('--config='.length));
  });
  const out = values
    .filter((v) => path.isAbsolute(v))
    .map((v) => (isDir(v) ? v : path.dirname(v)))
    .map((dir) =>
      dir
        .split(/[\\/]+/)
        .map((seg) => seg.replace(/^\.+/, ''))
        .filter(Boolean)
        .join('.'),
    )
    .filter(Boolean);
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** Semgrep `errors[]` (code 0 still): "PartialParsing: Syntax error at line f.java:10: `%` was unexpected". */
function semgrepWarnings(errors: unknown[], ctx: NormalizeContext): string[] {
  const out = new Set<string>();
  for (const e of errors.map(obj)) {
    const type = Array.isArray(e.type) ? str(e.type[0]) : str(e.type);
    const msg = str(e.message).split(ctx.root + '/').join('').replace(/\s+/g, ' ').trim();
    out.add(`${type ? `${type}: ` : ''}${msg || str(e.path)}`);
  }
  return [...out];
}

/** Semgrep `--json`: results[] with check_id, path, start/end, extra.{message, severity, metadata, lines}. */
export const normalizeSemgrep: Normalizer = (output, ctx) => {
  const doc = obj(parseJson(output, 'semgrep'));
  const rows: NormalizedFinding[] = [];
  const prefixes = semgrepRulePrefixes(ctx.args ?? []);
  for (const w of semgrepWarnings(arr(doc.errors), ctx)) ctx.warn?.(w);
  for (const r of arr(doc.results).map(obj)) {
    const extra = obj(r.extra);
    const meta = obj(extra.metadata);
    const rawId = str(r.check_id);
    const prefix = prefixes.find((p) => rawId.startsWith(p + '.'));
    const ruleId = prefix ? rawId.slice(prefix.length + 1) : rawId;
    const file = repoPath(str(r.path), ctx);
    const line = num(obj(r.start).line);
    const lines = str(extra.lines);
    // Without a Semgrep login `lines` and `fingerprint` read "requires login".
    const snippetKnown = lines && lines !== 'requires login';
    const isSecret = /(^|\.)secrets?\./.test(ruleId) || arr(meta.technology).includes('secrets');
    const tags = [
      ...arr(meta.owasp).map(str),
      ...(meta.category ? [`category:${str(meta.category)}`] : []),
      ...(['confidence', 'likelihood', 'impact'] as const).filter((k) => meta[k]).map((k) => `${k}:${str(meta[k])}`),
    ];
    rows.push({
      kind: isSecret ? 'secret' : 'sast',
      ruleId,
      severity: severityOf(extra.severity, 'low'),
      title: ruleId.split('.').pop() || ruleId,
      message: str(extra.message).trim(),
      file,
      line,
      endLine: num(obj(r.end).line),
      cwe: cweIds(meta.cwe),
      tags,
      fingerprint: snippetKnown ? hash('semgrep', ruleId, file, lines.replace(/\s+/g, ' ').trim()) : hash('semgrep', ruleId, file, line),
      snippet: snippetKnown && !isSecret ? lines : null,
      data: { ...(meta.source ? { source: str(meta.source) } : {}), ...(meta.references ? { references: arr(meta.references).map(str).slice(0, 5) } : {}) },
    });
  }
  return dedupeFingerprints(rows);
};

/** Masks every occurrence of a secret in a matched line. */
function redact(text: string, secret: string): string {
  if (!secret) return text;
  const mask = secret.length > 8 ? `${secret.slice(0, 4)}…[hidden]` : '[hidden]';
  return text.split(secret).join(mask);
}

/** Gitleaks `--report-format json`: array of {RuleID, Description, File, StartLine, Match, Secret, Tags}. Secrets are never stored. */
export const normalizeGitleaks: Normalizer = (output, ctx) => {
  const rows: NormalizedFinding[] = [];
  for (const r of arr(parseJson(output, 'gitleaks')).map(obj)) {
    const secret = str(r.Secret);
    const ruleId = str(r.RuleID);
    const file = repoPath(str(r.File), ctx);
    rows.push({
      kind: 'secret',
      ruleId,
      severity: 'high',
      title: ruleId,
      message: str(r.Description).trim(),
      file,
      line: num(r.StartLine),
      endLine: num(r.EndLine),
      cwe: ['CWE-798'],
      tags: arr(r.Tags).map(str),
      fingerprint: hash('gitleaks', ruleId, file, hash(secret)),
      snippet: redact(str(r.Match), secret) || null,
      data: { entropy: r.Entropy ?? null },
    });
  }
  return dedupeFingerprints(rows);
};

/**
 * Trivy `fs --format json`: Results[] per target with Vulnerabilities (dependency CVEs, kept for SCA),
 * Secrets (already masked by trivy) and Misconfigurations (only failed checks).
 */
export const normalizeTrivy: Normalizer = (output, ctx) => {
  const doc = obj(parseJson(output, 'trivy'));
  const rows: NormalizedFinding[] = [];
  for (const res of arr(doc.Results).map(obj)) {
    const file = repoPath(str(res.Target), ctx);
    const type = str(res.Type);
    for (const v of arr(res.Vulnerabilities).map(obj)) {
      const id = str(v.VulnerabilityID);
      const pkg = str(v.PkgName);
      const version = str(v.InstalledVersion);
      const fixed = str(v.FixedVersion);
      rows.push({
        kind: 'vuln',
        ruleId: id,
        severity: severityOf(v.Severity),
        title: str(v.Title) || id,
        message: `${pkg}@${version}: ${str(v.Title) || id}${fixed ? ` (fixed in ${fixed})` : ''}`,
        file,
        line: null,
        endLine: null,
        cwe: cweIds(v.CweIDs),
        tags: [`class:${str(res.Class)}`, ...(type ? [`type:${type}`] : [])],
        fingerprint: hash('trivy-vuln', id, pkg, version, file),
        snippet: null,
        data: {
          package: pkg,
          version,
          vulnerability_id: id,
          fixed_version: fixed || null,
          purl: str(obj(v.PkgIdentifier).PURL) || null,
          pkg_id: str(v.PkgID) || null,
          pkg_type: type || null,
          target: file,
          status: str(v.Status) || null,
          primary_url: str(v.PrimaryURL) || null,
          description: str(v.Description).slice(0, 2000) || null,
        },
      });
    }
    for (const s of arr(res.Secrets).map(obj)) {
      const ruleId = str(s.RuleID);
      rows.push({
        kind: 'secret',
        ruleId,
        severity: severityOf(s.Severity, 'high'),
        title: str(s.Title) || ruleId,
        message: `${str(s.Category)}: ${str(s.Title) || ruleId}`.replace(/^: /, ''),
        file,
        line: num(s.StartLine),
        endLine: num(s.EndLine),
        cwe: ['CWE-798'],
        tags: s.Category ? [`category:${str(s.Category)}`] : [],
        fingerprint: hash('trivy-secret', ruleId, file, str(s.Match)),
        snippet: str(s.Match) || null,
        data: {},
      });
    }
    for (const m of arr(res.Misconfigurations).map(obj)) {
      if (m.Status && str(m.Status) !== 'FAIL') continue;
      const ruleId = str(m.ID) || str(m.AVDID);
      const cause = obj(m.CauseMetadata);
      const line = num(cause.StartLine);
      rows.push({
        kind: 'misconfig',
        ruleId,
        severity: severityOf(m.Severity),
        title: str(m.Title) || ruleId,
        message: str(m.Message) || str(m.Description),
        file,
        line,
        endLine: num(cause.EndLine),
        cwe: [],
        tags: [...(m.Type ? [`type:${str(m.Type)}`] : []), ...(type ? [`config:${type}`] : [])],
        fingerprint: hash('trivy-misconfig', ruleId, file, line, str(m.Message)),
        snippet: null,
        data: { resolution: str(m.Resolution) || null, primary_url: str(m.PrimaryURL) || null },
      });
    }
  }
  return dedupeFingerprints(rows);
};

/** Normalizers by `scanners.<name>.format`. */
export const NORMALIZERS: Record<string, Normalizer> = {
  semgrep: normalizeSemgrep,
  gitleaks: normalizeGitleaks,
  trivy: normalizeTrivy,
};
