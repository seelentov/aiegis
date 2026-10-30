import fs from 'node:fs';
import path from 'node:path';
import type { ScaItemRef } from '../shared/types';

/** Entity of a dependency inventory job (id = module id). */
export const SCA_MODULE_ENTITY = 'sca_module';
/** Entity of a reachability job and scope of its token (id = `<module_id>/<package_key>`). */
export const SCA_PACKAGE_ENTITY = 'sca_package';
/** Validity entity types (SPEC §5). */
export const SCA_VERDICT_VALIDITY = 'sca_verdict';
export const SCA_INVENTORY_VALIDITY = 'sca_inventory';
/** Directory of a run's own files (inputs, reports) inside its checkout. */
export const SCA_DIR = '.aiegis-sca';

/** Identity of a package version across inventories: `<ecosystem>:<name>@<version>`. */
export function packageKey(ecosystem: string, name: string, version: string): string {
  return `${ecosystem.trim().toLowerCase()}:${name.trim()}@${version.trim()}`;
}

export const scaItemId = (x: ScaItemRef) => `${x.moduleId}/${x.packageKey}#${x.vulnId}`;

export function parseScaItemId(id: string): ScaItemRef {
  const slash = id.indexOf('/');
  const hash = id.lastIndexOf('#');
  if (slash <= 0 || hash <= slash + 1 || hash === id.length - 1) throw new Error(`invalid SCA item id ${id}`);
  return { moduleId: id.slice(0, slash), packageKey: id.slice(slash + 1, hash), vulnId: id.slice(hash + 1) };
}

export const scaPackageEntityId = (moduleId: string, key: string) => `${moduleId}/${key}`;

export function parseScaPackageEntityId(id: string): { moduleId: string; packageKey: string } {
  const i = id.indexOf('/');
  if (i <= 0) throw new Error(`invalid package id ${id}`);
  return { moduleId: id.slice(0, i), packageKey: id.slice(i + 1) };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches code references to any of the import names, language-agnostic: the name must not continue an identifier
 * on either side ("com.foo" matches "import com.foo.Bar" and "require('com.foo')", not "com.foobar" or "xcom.foo").
 */
export function importPattern(names: string[]): RegExp | null {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!clean.length) return null;
  return new RegExp(`(?<![\\w$])(?:${clean.map(escape).join('|')})(?![\\w$])`);
}

/**
 * Prefilter without AI (SPEC §4, Q11): module files (relative to `root`) that mention one of the import names.
 * Binary and oversized files are skipped.
 */
export function findImports(root: string, files: string[], names: string[], maxBytes: number): string[] {
  const re = importPattern(names);
  if (!re) return [];
  const hits: string[] = [];
  for (const f of files) {
    const abs = path.join(root, f);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile() || st.size > maxBytes) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue;
    if (re.test(buf.toString('utf8'))) hits.push(f);
  }
  return hits;
}

/**
 * Anti-hallucination check of an inventory record: the tool report must mention the package and every vulnerability
 * (by its id or one of its aliases). Returns the ids that are not found.
 */
export function missingInReport(report: string, pkg: { name: string }, vulns: { id: string; aliases?: string[] }[]): { package: boolean; vulns: string[] } {
  const short = pkg.name.includes(':') ? pkg.name.slice(pkg.name.lastIndexOf(':') + 1) : pkg.name.replace(/^@[^/]+\//, '');
  return {
    package: !report.includes(pkg.name) && !report.includes(short),
    vulns: vulns.filter((v) => ![v.id, ...(v.aliases ?? [])].some((a) => a && report.includes(a))).map((v) => v.id),
  };
}

/** A path inside `root` given relative to it; null if it escapes or does not exist as a file. */
export function fileInside(root: string, rel: string): string | null {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  const abs = path.join(root, rel);
  return fs.statSync(abs, { throwIfNoEntry: false })?.isFile() ? abs : null;
}

/** Files a reachability verdict depends on (SPEC §5): evidence, the package's manifest and, if reachable, finding files. */
export function scaTouched(evidence: { file: string }[], pkg: { manifest: string | null }, findings: { files: { file: string }[] }[]): string[] {
  return [...new Set([...evidence.map((e) => e.file), ...(pkg.manifest ? [pkg.manifest] : []), ...findings.flatMap((f) => f.files.map((x) => x.file))])].sort();
}
