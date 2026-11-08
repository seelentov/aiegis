import { createContext } from 'react';
import type { MenuItemSpec } from '../shared/types';
import { api } from './api';
import { tr } from './i18n';

/** An action of a context menu, `null` for a separator; `false`/`undefined` entries are skipped (conditional items). */
export type MenuEntry =
  | { label: string; run?: () => void; enabled?: boolean; checked?: boolean; accelerator?: string; role?: MenuItemSpec['role'] }
  | null
  | false
  | undefined;

/** Pops up a native context menu for a right-click and runs the picked entry. */
export function showMenu(e: { preventDefault(): void; stopPropagation(): void }, entries: MenuEntry[]): void {
  e.preventDefault();
  e.stopPropagation();
  const list = entries.filter((x): x is Exclude<MenuEntry, false | undefined> => x !== false && x !== undefined);
  // No separator at the ends or twice in a row.
  const clean = list.filter((x, i) => x !== null || (i > 0 && i < list.length - 1 && list[i - 1] !== null));
  const items: MenuItemSpec[] = clean.map((x, i) =>
    x === null
      ? { type: 'separator' }
      : {
          id: x.role ? undefined : String(i),
          label: x.label,
          role: x.role,
          type: x.checked === undefined ? 'normal' : 'checkbox',
          checked: x.checked,
          enabled: x.enabled ?? true,
          accelerator: x.accelerator,
        },
  );
  if (!items.length) return;
  void api.contextMenu(items).then((id) => {
    const x = id === null ? null : clean[Number(id)];
    x?.run?.();
  });
}

export const copyText = (text: string) => void navigator.clipboard.writeText(text);

/** Cut/copy/paste for text fields and selected text, which Electron leaves without a context menu. */
export function installEditMenu(): void {
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    const field = t.closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea, [contenteditable="true"]');
    const selected = (window.getSelection()?.toString() ?? '') !== '';
    if (!field && !selected) return;
    const editable = field !== null && !field.readOnly && !field.disabled;
    showMenu(e, [
      editable && { label: tr('Cut'), role: 'cut', enabled: selected || hasFieldSelection(field) },
      { label: tr('Copy'), role: 'copy', enabled: selected || hasFieldSelection(field) },
      editable && { label: tr('Paste'), role: 'paste' },
      null,
      { label: tr('Select all'), role: 'selectAll' },
    ]);
  });
}

function hasFieldSelection(f: HTMLInputElement | HTMLTextAreaElement | null): boolean {
  // selectionStart throws on input types without a caret (checkbox, number in some engines).
  try {
    return f !== null && 'selectionStart' in f && f.selectionStart !== f.selectionEnd;
  } catch {
    return false;
  }
}

export const MAC = globalThis.navigator?.platform?.startsWith('Mac') ?? false;
/** Modifier as shown in hints: ⌘ on macOS, Ctrl+ elsewhere. */
export const MOD = MAC ? '⌘' : 'Ctrl+';
/** The command key of VS Code bindings: ⌘ on macOS, Ctrl elsewhere. */
export const cmdKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (MAC ? e.metaKey : e.ctrlKey);

/** Project of the open section: menus resolve relative `file:line` against its root. */
export const ProjectIdContext = createContext<string | null>(null);

// `path/to/file.ext:line[:col]`, standing alone (not inside a URL); the path may be absolute or relative to the project.
export const FILE_LINE = /(^|[\s'"`(\[<])((?:\.{0,2}\/)?(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z]\w*):(\d+)(?::\d+)?/g;
