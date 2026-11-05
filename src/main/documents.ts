import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DocFormat, DocInfo, DocPlanEntry } from '../shared/types';

/** File names inside a document version directory (`<data>/<project>/documents/<version-id>/`). */
export const SOURCE_BASENAME = 'source';
export const TEXT_FILE = 'text.md';
/** Text of a PDF while an agent is still writing it. */
export const TEXT_PART_FILE = 'text.part';

export function detectFormat(filename: string): DocFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return 'md';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  throw new Error(`format ${ext || filename} is not supported: MD, PDF or DOCX is required`);
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Copies an imported document into its version directory and prepares what the agent reads:
 * MD and DOCX become `text.md` (also used to verify quotes); PDF is read by claude itself, and gets `text.md` from an
 * agent when a document check first needs it.
 * Returns the file name the agent should read.
 */
export async function stageDocument(src: string, dir: string, format: DocFormat): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const source = `${SOURCE_BASENAME}${path.extname(src).toLowerCase()}`;
  fs.copyFileSync(src, path.join(dir, source));
  if (format === 'pdf') return source;
  const text = format === 'docx' ? await docxText(src) : fs.readFileSync(src, 'utf8');
  fs.writeFileSync(path.join(dir, TEXT_FILE), text);
  return TEXT_FILE;
}

async function docxText(file: string): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ path: file });
  return value;
}

/** Extracted text of a version, or null for formats claude reads directly (PDF). */
export function documentText(dir: string): string | null {
  const f = path.join(dir, TEXT_FILE);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

/** Agent-facing file of a version directory. */
export function agentFile(dir: string): string {
  if (fs.existsSync(path.join(dir, TEXT_FILE))) return TEXT_FILE;
  const src = fs.readdirSync(dir).find((f) => f.startsWith(`${SOURCE_BASENAME}.`));
  if (!src) throw new Error(`no document file in ${dir}`);
  return src;
}

/** Requirements of different documents with mostly the same words: pairs, the closest first. Nothing is merged. */
/**
 * The grounds of a requirement as one line, from what is known: nothing is made up for a document that does not say.
 * A generated key (R-001) is not in the document, so it names nothing there.
 */
export function citationOf(title: string, info: DocInfo, item: { key: string; clause: string; section: string }): string {
  const clause = item.clause || (/^R-\d+$/.test(item.key) ? '' : item.key);
  return [info.name || title, info.number, info.date, info.edition, clause, item.section].filter(Boolean).join(', ');
}

export function probableRepeats<T extends { documentId: string; text: string }>(items: T[], minSimilarity: number): { similarity: number; a: T; b: T }[] {
  const words = items.map((i) => new Set(i.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
  const out: { similarity: number; a: T; b: T }[] = [];
  items.forEach((a, i) => {
    for (let j = i + 1; j < items.length; j++) {
      if (a.documentId === items[j].documentId) continue;
      const [x, y] = [words[i], words[j]];
      if (!x.size || !y.size) continue;
      let shared = 0;
      for (const w of x) if (y.has(w)) shared++;
      const similarity = shared / (x.size + y.size - shared);
      if (similarity >= minSimilarity) out.push({ similarity, a, b: items[j] });
    }
  });
  return out.sort((p, q) => q.similarity - p.similarity);
}

/** Stored copy of the imported file, or null. */
export function sourceFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const src = fs.readdirSync(dir).find((f) => f.startsWith(`${SOURCE_BASENAME}.`));
  return src ? path.join(dir, src) : null;
}

/** Generated security documents (SPEC §22): a plan job splits the application into documents, one job writes each. */
export const DOC_PLAN_ENTITY = 'doc_plan';
export const DOC_GEN_ENTITY = 'doc_gen';
/** A check of a set (`set:<id>`) or of one document (`doc:<id>`) against its links (SPEC §24). */
export const DOC_REFRESH_ENTITY = 'doc_refresh';
/** One reading of a PDF into text; the entity id is the document version. */
export const DOC_TEXT_ENTITY = 'doc_text';


/**
 * Validates a document plan: unique slugs and key prefixes, known modules, every module covered by some document,
 * slugs of earlier generated documents keep their key prefix.
 */
export function checkDocPlan(plan: DocPlanEntry[], moduleNames: string[], existing: DocPlanEntry[]): void {
  if (!plan.length) throw new Error('the plan has no documents');
  const seen = (what: string, values: string[]) => {
    const dup = values.find((v, i) => values.indexOf(v) !== i);
    if (dup) throw new Error(`duplicate ${what} ${dup}`);
  };
  seen('slug', plan.map((d) => d.slug));
  seen('key_prefix', plan.map((d) => d.key_prefix));
  for (const d of plan) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.slug)) throw new Error(`slug ${d.slug}: use lowercase kebab-case`);
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(d.key_prefix)) throw new Error(`key_prefix ${d.key_prefix}: 2-10 uppercase letters or digits`);
    if (!d.sections.length) throw new Error(`document ${d.slug} has no sections`);
    const unknown = d.modules.filter((m) => !moduleNames.includes(m));
    if (unknown.length) throw new Error(`document ${d.slug}: unknown modules ${unknown.join(', ')}; see list_modules`);
    const prev = existing.find((e) => e.slug === d.slug);
    if (prev && prev.key_prefix !== d.key_prefix) throw new Error(`document ${d.slug} keeps its key_prefix ${prev.key_prefix}`);
    const other = existing.find((e) => e.slug !== d.slug && e.key_prefix === d.key_prefix);
    if (other) throw new Error(`key_prefix ${d.key_prefix} belongs to the generated document ${other.slug}`);
  }
  if (!plan.some((d) => !d.modules.length)) {
    const covered = new Set(plan.flatMap((d) => d.modules));
    const left = moduleNames.filter((m) => !covered.has(m));
    if (left.length) throw new Error(`modules not covered by any document: ${left.join(', ')}`);
  }
}

export interface GeneratedItem {
  key: string;
  text: string;
  section: string;
}

/**
 * Requirements of a generated document: lines `- **PREFIX-n** text` under `## Section` headings.
 * Other lines (scope, context, indented rationale) are prose for humans and are not parsed.
 */
export function parseGeneratedDoc(md: string, prefix: string): { title: string; items: GeneratedItem[] } {
  const title = /^#\s+(.+)$/m.exec(md)?.[1].trim();
  if (!title) throw new Error('the document has no "# Title" heading');
  let section = '';
  const items: GeneratedItem[] = [];
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) section = h[1].trim();
    const m = /^[-*]\s+\*\*([A-Za-z][A-Za-z0-9]*-\d+):?\*\*:?\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    if (!m[1].startsWith(`${prefix}-`)) throw new Error(`requirement ${m[1]}: ids of this document start with ${prefix}-`);
    if (!section) throw new Error(`requirement ${m[1]} is not under a "## Section" heading`);
    if (items.some((i) => i.key === m[1])) throw new Error(`duplicate requirement id ${m[1]}`);
    items.push({ key: m[1], text: m[2].trim(), section });
  }
  if (!items.length) throw new Error(`no requirements found: write each as a list item "- **${prefix}-1** The application must …"`);
  return { title, items };
}
