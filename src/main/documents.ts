import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DocFormat } from '../shared/types';

/** File names inside a document version directory (`<data>/<project>/documents/<version-id>/`). */
export const SOURCE_BASENAME = 'source';
export const TEXT_FILE = 'text.md';

export function detectFormat(filename: string): DocFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return 'md';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  throw new Error(`формат ${ext || filename} не поддерживается: нужен MD, PDF или DOCX`);
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Copies an imported document into its version directory and prepares what the agent reads:
 * MD and DOCX become `text.md` (also used to verify quotes); PDF is read by claude itself.
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
  if (!src) throw new Error(`в ${dir} нет файла документа`);
  return src;
}

/** Stored copy of the imported file, or null. */
export function sourceFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const src = fs.readdirSync(dir).find((f) => f.startsWith(`${SOURCE_BASENAME}.`));
  return src ? path.join(dir, src) : null;
}
