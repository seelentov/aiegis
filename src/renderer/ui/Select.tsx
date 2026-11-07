import { Children, isValidElement, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { tr } from '../i18n';

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

/** From this many options the search field stays visible; in shorter lists it appears once the user types. */
const SEARCH_VISIBLE_FROM = 7;

// shortcut: only direct <option> and <optgroup> children are read, a fragment or a wrapper component needs unwrapping here.
export function optionsOf(children: ReactNode, group?: string): SelectOption[] {
  return Children.toArray(children).flatMap((c) => {
    if (!isValidElement(c)) return [];
    const p = c.props as { value?: string; label?: string; disabled?: boolean; children?: ReactNode };
    if (c.type === 'optgroup') return optionsOf(p.children, p.label);
    const label = Children.toArray(p.children).join('');
    return [{ value: p.value ?? label, label, group, disabled: p.disabled }];
  });
}

/** Every word of the query must occur in the label, in any order: "auth fix" finds "fix/oauth-token". */
export function matchOptions(options: SelectOption[], query: string): SelectOption[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((o) => {
    const label = o.label.toLowerCase();
    return terms.every((t) => label.includes(t));
  });
}

/** The next enabled option from `from` in direction `dir`; stays at `from` when there is none. */
export function stepOption(options: SelectOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i;
  return from;
}

interface SelectProps<V extends string> {
  value: V;
  onChange: (value: V) => void;
  /** `<option>` and `<optgroup>` elements, as in a native select. */
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  title?: string;
  'aria-label'?: string;
}

/**
 * A select with search. The native popover gives the top layer, light dismiss, Escape and focus return;
 * CSS anchor positioning keeps the panel beside the trigger inside scrolling panes.
 */
export function Select<V extends string>({ value, onChange, children, disabled, className, title, 'aria-label': ariaLabel }: SelectProps<V>) {
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const options = optionsOf(children);
  const anchor = `--select-${id.replace(/\W/g, '')}`;
  const long = options.length >= SEARCH_VISIBLE_FROM;

  const onTriggerKey = (e: React.KeyboardEvent) => {
    const printable = e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!printable && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (printable) setTyped(e.key);
    popover.current?.showPopover();
  };

  return (
    <>
      <button
        type="button"
        className={`select-trigger ${className ?? ''}`}
        style={{ anchorName: anchor } as CSSProperties}
        popoverTarget={id}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onKeyDown={onTriggerKey}
      >
        <span className="select-value">{options.find((o) => o.value === value)?.label}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {/* In body: a click inside must not reach a <label> around the trigger, which would toggle the panel. */}
      {createPortal(
        <div
          ref={popover}
          id={id}
          popover="auto"
          className={long ? 'select-panel long' : 'select-panel'}
          style={{ positionAnchor: anchor } as CSSProperties}
          onBeforeToggle={(e) => e.newState === 'open' && setOpen(true)}
          // The panel goes only after closing: the browser returns focus to the trigger only if it is still inside.
          onToggle={(e) => {
            if (e.newState === 'open') {
              popover.current?.querySelector('input')?.focus();
            } else {
              setOpen(false);
              setTyped('');
            }
          }}
          // The panel is a React child of whatever holds the trigger, a table row for one.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {open && (
            <Panel
              options={options}
              value={value}
              long={long}
              initialQuery={typed}
              onPick={(v) => {
                popover.current?.hidePopover();
                if (v !== value) onChange(v as V);
              }}
              onTab={() => popover.current?.hidePopover()}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function Panel({ options, value, long, initialQuery, onPick, onTab }: { options: SelectOption[]; value: string; long: boolean; initialQuery: string; onPick: (v: string) => void; onTab: () => void }) {
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const shown = matchOptions(options, query);
  const [active, setActive] = useState(() => {
    const i = shown.findIndex((o) => o.value === value);
    return i >= 0 ? i : stepOption(shown, -1, 1);
  });

  // Braces matter: scrollIntoView returns a promise in this Chromium, and an effect must not return one.
  useEffect(() => {
    list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => stepOption(shown, i, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active] && !shown[active].disabled) onPick(shown[active].value);
    } else if (e.key === 'Tab') {
      // Focus returns to the trigger first, so Tab goes on from there, not from the end of the body.
      onTab();
    }
  };

  return (
    <>
      <input
        className={long || query ? 'select-search' : 'visually-hidden'}
        role="combobox"
        aria-label={tr('Search the list')}
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        placeholder={tr('search')}
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(stepOption(matchOptions(options, e.target.value), -1, 1));
        }}
        onKeyDown={onKey}
      />
      <ul ref={list} id={listId} role="listbox" className="select-list">
        {shown.map((o, i) => (
          <li key={`${o.group ?? ''}:${o.value}`} className={o.group !== undefined && o.group !== shown[i - 1]?.group ? 'select-group-start' : undefined} data-group={o.group}>
            <div
              id={`${listId}-${i}`}
              role="option"
              className="select-option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              aria-label={o.group ? `${o.group}: ${o.label}` : undefined}
              data-active={i === active || undefined}
              title={o.label}
              // Keeps focus in the search field, which owns the keyboard.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => !o.disabled && i !== active && setActive(i)}
              onClick={() => !o.disabled && onPick(o.value)}
            >
              <span className="select-value">{o.label}</span>
              {o.value === value && <Icon name="check" size={14} />}
            </div>
          </li>
        ))}
        {shown.length === 0 && <li className="select-none">{tr('Nothing found')}</li>}
      </ul>
    </>
  );
}
