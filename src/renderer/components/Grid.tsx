import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon, IconButton } from './Icon';
import { lang, tr } from '../i18n';

export interface Col<T> {
  key: string;
  title: ReactNode;
  /** Text the column filters on; a column without it is neither filterable nor sortable. */
  text?: (r: T) => string;
  /** Sort key when it differs from the text (severity rank, timestamps). */
  sort?: (r: T) => string | number;
  /** `enum` filters by a select of the distinct values, `text` by substring. */
  filter?: 'text' | 'enum';
  className?: string;
  /** Controls placed in the header cell beside the title (a column action). */
  extra?: ReactNode;
}

interface GridState {
  sort: { key: string; dir: 1 | -1 } | null;
  filters: Record<string, string>;
}

// Per-table state survives tab switches for the session.
const memory = new Map<string, GridState>();
const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });

export function useGrid<T>(id: string, rows: T[], cols: Col<T>[]) {
  const [state, setState] = useState<GridState>(() => memory.get(id) ?? { sort: null, filters: {} });
  useEffect(() => void memory.set(id, state), [id, state]);

  const shown = useMemo(() => {
    const active = cols.filter((c) => c.text && state.filters[c.key]);
    let out = rows.filter((r) =>
      active.every((c) => {
        const v = c.text!(r);
        const f = state.filters[c.key];
        return c.filter === 'enum' ? v === f : v.toLowerCase().includes(f.toLowerCase());
      }),
    );
    const sc = state.sort && cols.find((c) => c.key === state.sort!.key);
    if (sc?.text) {
      const key = sc.sort ?? sc.text;
      const dir = state.sort!.dir;
      out = [...out].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y)));
      });
    }
    return out;
  }, [rows, cols, state]);

  const setFilter = (key: string, v: string) => setState((s) => ({ ...s, filters: { ...s.filters, [key]: v } }));
  const toggleSort = (key: string) =>
    setState((s) => ({ ...s, sort: s.sort?.key !== key ? { key, dir: 1 } : s.sort.dir === 1 ? { key, dir: -1 } : null }));
  const filtered = Object.values(state.filters).some(Boolean);
  const reset = () => setState({ sort: null, filters: {} });

  const head = (
    <thead>
      <tr>
        {cols.map((c) => {
          const dir = state.sort?.key === c.key ? state.sort.dir : 0;
          return (
            <th key={c.key} className={c.className} aria-sort={dir === 1 ? 'ascending' : dir === -1 ? 'descending' : undefined}>
              {c.text ? (
                <button className={dir ? 'th-sort sorted' : 'th-sort'} onClick={() => toggleSort(c.key)}>
                  {c.title}
                  <Icon name={dir === -1 ? 'sortDesc' : 'sortAsc'} size={12} />
                </button>
              ) : (
                c.title
              )}
              {c.extra}
            </th>
          );
        })}
      </tr>
      <tr className="filter-row">
        {cols.map((c) => (
          <th key={c.key} className={c.className}>
            {c.text && <ColumnFilter col={c} rows={rows} value={state.filters[c.key] ?? ''} onChange={(v) => setFilter(c.key, v)} />}
          </th>
        ))}
      </tr>
    </thead>
  );

  const count =
    filtered || state.sort ? (
      <span className="grid-count">
        {filtered && (
          <span className="muted">
            {tr('{n} of {total}', { n: shown.length, total: rows.length })}
          </span>
        )}
        <IconButton icon="clearFilter" title={tr('Reset filters and sorting')} onClick={reset} />
      </span>
    ) : null;

  return { rows: shown, head, count, filtered, sorted: Boolean(state.sort), colSpan: cols.length };
}

function ColumnFilter<T>({ col, rows, value, onChange }: { col: Col<T>; rows: T[]; value: string; onChange: (v: string) => void }) {
  const label = tr('Filter: {column}', { column: typeof col.title === 'string' ? col.title : col.key });
  if (col.filter === 'enum') {
    const options = [...new Set(rows.map(col.text!))].filter(Boolean).sort(collator.compare);
    return (
      <select className={value ? 'col-filter set' : 'col-filter'} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tr('all')}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className={value ? 'col-filter set' : 'col-filter'}
      type="search"
      aria-label={label}
      placeholder={tr('search')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Escape' && onChange('')}
    />
  );
}

/** Row shown when a grid body is empty: distinguishes "nothing yet" from "nothing matches". */
export function EmptyRow({ colSpan, filtered, children }: { colSpan: number; filtered: boolean; children: ReactNode }) {
  return (
    <tr className="empty-row">
      <td colSpan={colSpan}>{filtered ? tr('Nothing matches the filters') : children}</td>
    </tr>
  );
}
