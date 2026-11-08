import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit, SearchKind } from '../../shared/types';
import { api } from '../api';
import { tr } from '../i18n';
import { MOD } from '../menu';
import { Input } from '../ui';
import { usePersisted } from './Splitter';

export interface PaletteCommand {
  id: string;
  title: string;
  /** Shortcut shown on the right. */
  keys?: string;
  run: () => void;
}

export const HIT_KIND: Record<SearchKind, string> = {
  finding: tr('Findings'),
  signal: tr('Signals'),
  suppression: tr('Suppressions'),
  sca: 'SCA',
  module: tr('Modules'),
  document: tr('Documents'),
  'doc-proposal': tr('Document proposals'),
  matrix: tr('Matrices'),
  'diff-check': tr('Branch checks'),
  schedule: tr('Schedules'),
  job: tr('Jobs'),
  session: tr('Sessions'),
};

// Typed before a space, a prefix narrows the search to some kinds, as the tabs of Search Everywhere in IDEA.
const PREFIXES: { prefix: string; kinds: SearchKind[] }[] = [
  { prefix: 'f', kinds: ['finding'] },
  { prefix: 's', kinds: ['signal', 'suppression'] },
  { prefix: 'sca', kinds: ['sca'] },
  { prefix: 'm', kinds: ['module'] },
  { prefix: 'd', kinds: ['document', 'doc-proposal', 'matrix'] },
  { prefix: 'j', kinds: ['job', 'session', 'schedule', 'diff-check'] },
];

const RECENT = 12;
const LIMIT = 60;

interface Props {
  projectId: string | null;
  /** Text the field opens with: `>` for commands. */
  initial: string;
  commands: PaletteCommand[];
  onOpen: (hit: SearchHit, inEditor: boolean) => void;
  onClose: () => void;
}

/** Search everywhere (⌘P, Shift twice) and, after `>`, the command palette (⌘⇧P). */
export function SearchPalette({ projectId, initial, commands, onOpen, onClose }: Props) {
  const [query, setQuery] = useState(initial);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = usePersisted<{ projectId: string; hit: SearchHit }[]>('recentHits', []);
  const list = useRef<HTMLUListElement>(null);

  const commandMode = query.startsWith('>');
  const words = (commandMode ? query.slice(1) : query).toLowerCase().split(/\s+/).filter(Boolean);
  const scope = !commandMode && words.length > 1 ? PREFIXES.find((p) => `${p.prefix}:` === words[0]) : undefined;
  const text = (scope ? words.slice(1) : words).join(' ');

  useEffect(() => {
    if (commandMode || !projectId || !text) return setHits([]);
    let current = true;
    // Debounced: every keystroke would otherwise rebuild the project's index in the main process.
    const t = setTimeout(() => {
      void api.search(projectId, text, scope ? LIMIT * 4 : LIMIT).then(
        (h) => current && (setHits(scope ? h.filter((x) => scope.kinds.includes(x.kind)).slice(0, LIMIT) : h), setActive(0)),
        () => current && setHits([]),
      );
    }, 120);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [commandMode, projectId, text, scope?.prefix]);

  const shownCommands = useMemo(
    () => (commandMode ? commands.filter((c) => words.every((w) => c.title.toLowerCase().includes(w))) : []),
    [commandMode, commands, query],
  );
  const recentHits = recent.filter((r) => r.projectId === projectId).map((r) => r.hit);
  const shownHits = commandMode ? [] : text ? hits : recentHits;
  const count = commandMode ? shownCommands.length : shownHits.length;

  useEffect(() => {
    list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const openHit = (h: SearchHit, inEditor: boolean) => {
    if (projectId) setRecent([{ projectId, hit: h }, ...recent.filter((r) => !(r.projectId === projectId && r.hit.kind === h.kind && r.hit.id === h.id))].slice(0, RECENT * 4));
    onClose();
    onOpen(h, inEditor);
  };
  const pick = (i: number, inEditor = false) => {
    if (commandMode) {
      const c = shownCommands[i];
      if (c) (onClose(), c.run());
    } else if (shownHits[i]) openHit(shownHits[i], inEditor);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (count) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastKind: SearchKind | null = null;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label={commandMode ? tr('Commands') : tr('Search everywhere')}>
        <Input
          autoFocus
          type="search"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={count ? `palette-${active}` : undefined}
          placeholder={commandMode ? tr('Command') : tr('Search everywhere: id, title, file, CWE, package; > for commands')}
          value={query}
          onChange={(e) => (setQuery(e.target.value), setActive(0))}
          onKeyDown={onKey}
        />
        <ul id="palette-list" ref={list} role="listbox" className="palette-list">
          {commandMode &&
            shownCommands.map((c, i) => (
              <li key={c.id} id={`palette-${i}`} role="option" aria-selected={i === active} data-active={i === active || undefined} onMouseMove={() => setActive(i)} onClick={() => pick(i)}>
                <span className="palette-title">{c.title}</span>
                {c.keys && <kbd>{c.keys}</kbd>}
              </li>
            ))}
          {!commandMode &&
            shownHits.map((h, i) => {
              // Results group by kind; recent ones are a single group.
              const head = text ? (h.kind !== lastKind ? (lastKind = h.kind) : null) : i === 0;
              return [
                head && (
                  <li key={`k-${h.kind}-${i}`} role="presentation" className="palette-group">
                    {text ? HIT_KIND[h.kind] : tr('Recently opened')}
                  </li>
                ),
                <li
                  key={`${h.kind}:${h.id}`}
                  id={`palette-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active || undefined}
                  onMouseMove={() => setActive(i)}
                  onClick={(e) => pick(i, e.metaKey || e.ctrlKey)}
                >
                  <span className="palette-title">{h.title || h.id}</span>
                  <span className="palette-detail">{h.location ? `${h.location.file}${h.location.line ? `:${h.location.line}` : ''}` : h.detail}</span>
                </li>,
              ];
            })}
        </ul>
        <div className="palette-foot muted small">
          {commandMode
            ? shownCommands.length === 0 && tr('No commands match')
            : !projectId
              ? tr('Add a project to search it')
              : text && hits.length === 0
                ? tr('Nothing found')
                : tr('Enter opens, {mod}Enter opens the file in the editor. Prefixes: f: findings, s: signals, sca:, m: modules, d: documents, j: jobs and sessions', { mod: MOD })}
        </div>
      </div>
    </div>
  );
}
