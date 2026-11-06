import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
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
  /** Limits of the `sarif` config section (required by the SARIF normalizer). */
  sarif?: SarifLimits;
  /** Directory the report's absolute paths start with when the report does not say so itself. */
  sourceRoot?: string | null;
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
    if (m) out.add(`CWE-${Number(m[1])}`);
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
  NONE: 'info',
  RECOMMENDATION: 'low',
  BLOCKER: 'critical',
  MAJOR: 'high',
  MINOR: 'low',
};

export function severityOf(v: unknown, fallback: Severity = 'info'): Severity {
  return SEVERITY_WORDS[str(v).toUpperCase()] ?? fallback;
}

/** Makes fingerprints unique within one output (identical matches in one file get an occurrence index). */
export function dedupeFingerprints(rows: NormalizedFinding[]): NormalizedFinding[] {
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

// --- SARIF 2.1.0: external reports are untrusted input (SPEC §29) ---

export interface SarifLimits {
  max_results: number;
  max_text_chars: number;
  max_code_flows: number;
  max_flow_steps: number;
}

const SarifRuleSchema = z.looseObject({ id: z.string() });
const SarifSchema = z.looseObject({
  version: z.literal('2.1.0'),
  runs: z
    .array(
      z.looseObject({
        tool: z.looseObject({
          driver: z.looseObject({ name: z.string().min(1), rules: z.array(SarifRuleSchema).optional() }),
          extensions: z.array(z.looseObject({ rules: z.array(SarifRuleSchema).optional() })).optional(),
        }),
        // An absent array means "results not determined" in SARIF: it must not read as a clean scan.
        results: z.array(
          z.looseObject({
            message: z.looseObject({ text: z.string().optional(), markdown: z.string().optional(), id: z.string().optional() }),
            ruleId: z.string().optional(),
            locations: z.array(z.looseObject({})).optional(),
            codeFlows: z.array(z.looseObject({})).optional(),
          }),
        ),
        versionControlProvenance: z.array(z.looseObject({ revisionId: z.string().optional() })).optional(),
        originalUriBaseIds: z.record(z.string(), z.looseObject({ uri: z.string().optional() })).optional(),
      }),
    )
    .min(1),
});

export type SarifRun = z.infer<typeof SarifSchema>['runs'][number];

/** Checks the shape and the limits of a report; the error names the first bad field and never quotes report text. */
export function parseSarif(output: string, limits: Pick<SarifLimits, 'max_results'>): SarifRun[] {
  const parsed = SarifSchema.safeParse(parseJson(output, 'SARIF'));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid SARIF 2.1.0: ${issue.path.join('.') || 'document'}: ${issue.message}`);
  }
  const total = parsed.data.runs.reduce((n, r) => n + r.results.length, 0);
  if (total > limits.max_results) throw new Error(`the report has ${total} results, over the limit sarif.max_results = ${limits.max_results}`);
  return parsed.data.runs;
}

const IMPORTED_PREFIX = 'sarif:';

/** Whether a scanner name belongs to an imported report (never to a configured scanner). */
export const isImportedScanner = (scanner: string) => scanner.startsWith(IMPORTED_PREFIX);

/** Scanner of an imported run: stable between imports (suppressions depend on it), never equal to a configured scanner. */
export function sarifScanner(run: SarifRun): string {
  const slug = run.tool.driver.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return IMPORTED_PREFIX + (slug || 'unknown');
}

export function sarifToolVersion(run: SarifRun): string | null {
  const d = run.tool.driver as Obj;
  return cleanText(d.semanticVersion ?? d.version, 80) || null;
}

/** Commits a run names; anything but a commit id (SVN revisions, branch names) does not count. */
export const sarifRevisions = (run: SarifRun): string[] => [...new Set((run.versionControlProvenance ?? []).map((v) => str(v.revisionId).trim()).filter((v) => /^[0-9a-f]{7,64}$/i.test(v)))];

const UNSAFE_TEXT = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;
/** Report text is untrusted: control and invisible characters go, the length is limited. */
const cleanText = (v: unknown, max: number) => str(v).replace(UNSAFE_TEXT, '').trim().slice(0, max);
/** Rule ids reach verdict prompts through suppressions: what cannot be an identifier (spaces, huge length) becomes a stable hash. */
const cleanRuleId = (v: unknown) => {
  const id = str(v);
  return /\s/.test(id) || id.length > 200 ? `rule-${hash(id)}` : id.replace(/[^\w./:@#+-]/g, '_');
};

const isAbsolute = (p: string) => /^(?:[a-zA-Z]:)?\//.test(p);

/** Decoded path of a URI or a plain path; null if it is not a file of this machine's kind (https:, file://host/). */
function uriPath(uri: string): string | null {
  let p = uri;
  if (/^[a-z][a-z0-9+.-]+:/i.test(uri)) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return null;
    }
    if (u.protocol !== 'file:' || !['', 'localhost'].includes(u.hostname)) return null;
    p = u.pathname.replace(/^\/([a-zA-Z]:)/, '$1');
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // A raw path with a stray "%".
  }
  return p.replace(/\\/g, '/');
}

/** Path of an artifactLocation (uri or index into run.artifacts) with its uriBaseId chain applied; null if there is no file. */
function artifactPath(location: unknown, run: Obj, depth = 0): string | null {
  const l = obj(location);
  const src = l.uri !== undefined ? l : obj(obj(arr(run.artifacts)[typeof l.index === 'number' ? l.index : -1]).location);
  if (typeof src.uri !== 'string' || !src.uri) return null;
  const p = uriPath(src.uri);
  if (p === null || isAbsolute(p) || !src.uriBaseId) return p;
  const base = obj(obj(run.originalUriBaseIds)[str(src.uriBaseId)]);
  if (base.uri === undefined || depth > 8) return p;
  const parent = artifactPath(base, run, depth + 1);
  return parent === null ? null : path.posix.join(parent, p);
}

/** Possible repository roots in a report's absolute paths, shortest first: that gives the fullest relative path. */
function sarifRoots(run: Obj, ctx: NormalizeContext): string[] {
  const named = [...Object.values(obj(run.originalUriBaseIds)), ...arr(run.versionControlProvenance).map((v) => obj(v).mappedTo)].map((l) => artifactPath(l, run));
  const roots = [ctx.root, ctx.sourceRoot, ...named].map((r) => (r ?? '').replace(/\\/g, '/').replace(/\/+$/, '')).filter(isAbsolute);
  return [...new Set(roots)].sort((a, b) => a.length - b.length);
}

/** Repository-relative file of a report path; null when it is outside the repository or absent from the checkout. */
function sarifFile(p: string | null, roots: string[], ctx: NormalizeContext): string | null {
  if (p === null) return null;
  const candidates = isAbsolute(p) ? roots.filter((r) => p.startsWith(r + '/')).map((r) => p.slice(r.length + 1)) : [p];
  for (const candidate of candidates) {
    const rel = path.posix.normalize(candidate);
    if (rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue;
    const file = repoPath(rel, ctx);
    if (ctx.exists(file)) return file;
  }
  return null;
}

/** Severity by how definite the source is: score, explicit word, tag, then the SARIF level (whose own default is "warning"). */
function sarifSeverity(result: Obj, rule: Obj, tags: string[], fallback: Severity): Severity {
  const props = [obj(result.properties), obj(rule.properties)];
  for (const p of props) {
    const score = Number(p['security-severity']);
    if (score > 0) return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  }
  const word = (v: unknown): Severity | undefined => SEVERITY_WORDS[str(v).toUpperCase()];
  for (const p of props) {
    const w = word(p.severity) ?? word(p.Severity) ?? word(p['problem.severity']);
    if (w) return w;
  }
  const tagged = tags.map((t) => /^(?:severity[:=/-])?(critical|high|medium|low)$/i.exec(t)?.[1]).find(Boolean);
  return word(tagged) ?? word(result.level) ?? word(obj(rule.defaultConfiguration).level) ?? (result.kind === 'informational' ? 'info' : fallback);
}

function sarifCwe(result: Obj, rule: Obj, tags: string[], ruleId: string): string[] {
  const isCweRef = (ref: unknown) => /^cwe$/i.test(str(obj(obj(ref).toolComponent).name));
  const refId = (ref: unknown) => `CWE-${str(obj(ref).id).replace(/^CWE-/i, '')}`;
  const props = [obj(result.properties), obj(rule.properties)].flatMap((p) =>
    Object.entries(p)
      .filter(([k]) => /cwe/i.test(k))
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .map((v) => (/^\d+$/.test(str(v)) ? `CWE-${str(v)}` : v)),
  );
  const relations = arr(rule.relationships).map((r) => obj(r).target).filter(isCweRef).map(refId);
  const taxa = arr(result.taxa).filter(isCweRef).map(refId);
  return cweIds([...props, ...tags, ...relations, ...taxa, ruleId]);
}

const SECRET_WORDS = /secret|credential|passw|api[-_ ]?key|private[-_ ]?key|gitleaks|trufflehog/i;
const SECRET_CWE = ['CWE-259', 'CWE-321', 'CWE-798'];

/** Semgrep without a login writes this instead of fingerprints and snippets. */
const NOT_LOGGED_IN = 'requires login';

/** Stable id a tool gives a result; commit and author keys (gitleaks) change between commits and are not one. */
function toolFingerprint(result: Obj): string | null {
  for (const source of [result.fingerprints, result.partialFingerprints]) {
    const o = obj(source);
    const key = Object.keys(o).filter((k) => !/commit|author|email|date/i.test(k) && str(o[k]) !== NOT_LOGGED_IN).sort()[0];
    if (key && o[key]) return str(o[key]);
  }
  return null;
}

/** One run in the shape of `raw_findings`; a run whose results all fall outside the repository is an error (wrong commit or root). */
export function normalizeSarifRun(run: SarifRun, ctx: NormalizeContext, limits: SarifLimits): NormalizedFinding[] {
  const r = run as Obj;
  const toolName = run.tool.driver.name;
  const extensions = (run.tool.extensions ?? []) as Obj[];
  const byId = new Map<string, Obj>();
  for (const c of [run.tool.driver as Obj, ...extensions]) for (const x of arr(c.rules).map(obj)) if (!byId.has(str(x.id))) byId.set(str(x.id), x);
  const roots = sarifRoots(r, ctx);
  const fileOf = (physical: Obj) => sarifFile(artifactPath(physical.artifactLocation, r), roots, ctx);
  const clean = (v: unknown) => cleanText(v, limits.max_text_chars);
  const rows: NormalizedFinding[] = [];
  const outside: string[] = [];
  if (arr(r.invocations).some((i) => obj(i).executionSuccessful === false)) ctx.warn?.(`${cleanText(toolName, 80)} reported that its run did not finish successfully: results may be incomplete`);

  for (const res of run.results as Obj[]) {
    // Not findings: checks that passed or did not apply, and results fixed since the baseline.
    if (res.kind === 'pass' || res.kind === 'notApplicable' || res.baselineState === 'absent') continue;
    const ref = obj(res.rule);
    const id = str(res.ruleId ?? ref.id);
    const index = ref.index ?? res.ruleIndex;
    const component = typeof obj(ref.toolComponent).index === 'number' ? extensions[obj(ref.toolComponent).index as number] : run.tool.driver;
    const rule = byId.get(id) ?? obj(arr(obj(component).rules)[typeof index === 'number' ? index : -1]);

    const physical = obj(obj(arr(res.locations)[0]).physicalLocation);
    const file = fileOf(physical);
    if (!file) {
      outside.push(cleanText(obj(physical.artifactLocation).uri, 200) || '(no file location)');
      continue;
    }
    const ruleId = cleanRuleId(id || rule.id) || 'unknown';
    const tags = [...new Set([...arr(obj(res.properties).tags), ...arr(obj(rule.properties).tags)].map((t) => cleanText(t, 100)).filter(Boolean))].slice(0, 30);
    const cwe = sarifCwe(res, rule, tags, ruleId);
    const isSecret = SECRET_WORDS.test([toolName, ruleId, str(rule.name), ...tags].join(' ')) || cwe.some((c) => SECRET_CWE.includes(c));
    const message = obj(res.message);
    const template = obj(obj(rule.messageStrings)[str(message.id)]);
    const args = arr(message.arguments);
    const text = (str(message.text) || str(message.markdown) || str(template.text) || str(template.markdown)).replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] === undefined ? m : str(args[Number(i)])));
    const region = obj(physical.region);
    const snippetText = str(obj(region.snippet).text).trim();
    const rawSnippet = snippetText === NOT_LOGGED_IN ? '' : snippetText;
    const flows = isSecret
      ? []
      : arr(res.codeFlows)
          .slice(0, limits.max_code_flows)
          .map((flow) => ({
            message: clean(obj(obj(flow).message).text),
            steps: arr(obj(flow).threadFlows)
              .flatMap((t) => arr(obj(t).locations))
              .slice(0, limits.max_flow_steps)
              .flatMap((step) => {
                const loc = obj(obj(step).location);
                const at = obj(loc.physicalLocation);
                const stepFile = fileOf(at);
                return stepFile ? [{ file: stepFile, line: num(obj(at.region).startLine), message: clean(obj(loc.message).text) }] : [];
              }),
          }))
          .filter((f) => f.steps.length);
    rows.push({
      kind: isSecret ? 'secret' : /^(CVE|GHSA)-/i.test(ruleId) ? 'vuln' : tags.some((t) => /^misconfig/i.test(t)) ? 'misconfig' : 'sast',
      ruleId,
      severity: sarifSeverity(res, rule, tags, isSecret ? 'high' : 'medium'),
      title: cleanText(str(obj(rule.shortDescription).text) || str(rule.name) || ruleId, limits.max_text_chars).split('\n')[0],
      // The snippet of a secret tool is the secret itself: it is not kept and is masked in the message.
      message: clean(isSecret ? redact(text, rawSnippet) : text) || clean(obj(rule.fullDescription).text),
      file,
      line: num(region.startLine),
      endLine: num(region.endLine),
      cwe,
      tags: [...tags, ...(arr(res.suppressions).length ? ['suppressed-in-tool'] : [])],
      // With rule and file inside, a report cannot hit a suppression of another finding by reusing its fingerprint.
      fingerprint: hash('sarif', ruleId, file, toolFingerprint(res) ?? (rawSnippet ? rawSnippet.replace(/\s+/g, ' ') : num(region.startLine))),
      snippet: isSecret ? null : clean(rawSnippet) || null,
      data: flows.length ? { code_flows: flows } : {},
    });
  }
  if (outside.length) {
    const what = `${outside.length} of ${run.results.length} results of ${cleanText(toolName, 80)} have no file in the repository at this commit (for example: ${outside[0]})`;
    if (!rows.length) throw new Error(`${what}. Check the commit; absolute paths from another machine need the source root`);
    ctx.warn?.(`${what}; they were skipped`);
  }
  return rows;
}

/** Report of a configured scanner with `format: sarif`. */
export const normalizeSarif: Normalizer = (output, ctx) => {
  if (!ctx.sarif) throw new Error('SARIF normalizer: the limits of the sarif config section are not set');
  const limits = ctx.sarif;
  return dedupeFingerprints(parseSarif(output, limits).flatMap((run) => normalizeSarifRun(run, ctx, limits)));
};

/** Normalizers by `scanners.<name>.format`. */
export const NORMALIZERS: Record<string, Normalizer> = {
  semgrep: normalizeSemgrep,
  gitleaks: normalizeGitleaks,
  trivy: normalizeTrivy,
  sarif: normalizeSarif,
};
