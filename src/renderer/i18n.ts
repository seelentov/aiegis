import type { Language } from '../shared/types';
import { RU } from './i18n-ru';

// The language is read synchronously so module-level labels are translated too; the global config is the source
// of truth, this copy only lets the first render use it (see `syncLanguage`).
const KEY = 'aiegis.language';

function stored(): Language {
  try {
    return localStorage.getItem(KEY) === 'ru' ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

export const lang: Language = stored();
export const locale = lang === 'ru' ? 'ru-RU' : 'en-US';

/**
 * UI text by its English source; `{name}` placeholders are filled from `vars`. A `|context` suffix tells apart
 * sources that read the same in English but not in Russian (`cancelled|run`); it is not shown.
 */
export function tr(en: string, vars?: Record<string, string | number>): string {
  const s = (lang === 'ru' && RU[en]) || en.replace(/\|[\w ]+$/, '');
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Applies the language from the global config; the page reloads when it differs from the one in use. */
export function syncLanguage(l: Language): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    return;
  }
  if (l !== lang) location.reload();
}
