import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { lang, tr } from '../i18n';
import type { Page, PageQuery } from '../../shared/types';
import { Button, IconButton, Input, Pager, pageSizes, pageSlice, Select } from '../ui';

export interface Col<T> {
  key: string;
  title: ReactNode;
  /** Text the column filters on; a column without it is neither filterable nor sortable. */
  text?: (r: T) => string;
  /** Sort key when it differs from the text (severity rank, timestamps). */
  sort?: (r: T) => string | number;
  /** `enum` filters by a select of the distinct values, `text` by substring, `none` leaves the column sortable only. */
  filter?: 'text' | 'enum' | 'none';
  /** Shown name of a value of an `enum` column, when it differs from the value. */
  label?: (value: string) => string;
  placeholder?: string;
  className?: string;
  /** Controls placed in the header cell beside the title (a column action). */
  extra?: ReactNode;
}

interface GridState {
  sort: { key: string; dir: 1 | -1 } | null;
  filters: Record<string, string>;
  page: number;
}

// Per-table state survives tab switches for the session.
const memory = new Map<string, GridState>();
const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });

/** `order` applies while no column sorts. `rows` is the current page, `all` every row that passes the filters. */
function useGridState(id: string) {
  const [state, setState] = useState<GridState>(() => memory.get(id) ?? { sort: null, filters: {}, page: 1 });
  useEffect(() => void memory.set(id, state), [id, state]);
  return {
    state,
    filtered: Object.values(state.filters).some(Boolean),
    setPage: (page: number) => setState((s) => ({ ...s, page })),
    setFilter: (key: string, v: string) => setState((s) => ({ ...s, page: 1, filters: { ...s.filters, [key]: v } })),
    toggleSort: (key: string) => setState((s) => ({ ...s, page: 1, sort: s.sort?.key !== key ? { key, dir: 1 } : s.sort.dir === 1 ? { key, dir: -1 } : null })),
    reset: () => setState({ sort: null, filters: {}, page: 1 }),
  };
}

function gridHead<T>(cols: Col<T>[], g: ReturnType<typeof useGridState>, options: (c: Col<T>) => string[]) {
  return (
    <thead>
      <tr>
        {cols.map((c) => {
          const dir = g.state.sort?.key === c.key ? g.state.sort.dir : 0;
          return (
            <th key={c.key} className={c.className} aria-sort={dir === 1 ? 'ascending' : dir === -1 ? 'descending' : undefined}>
              {c.text ? (
                <Button className={dir ? 'th-sort sorted' : 'th-sort'} onClick={() => g.toggleSort(c.key)}>
                  {c.title}
                  <Icon name={dir === -1 ? 'sortDesc' : 'sortAsc'} size={12} />
                </Button>
              ) : (
                c.title
              )}
              {c.extra}
            </th>
          );
        })}
      </tr>
      {cols.some((c) => c.text && c.filter !== 'none') && (
        <tr className="filter-row">
          {cols.map((c) => (
            <th key={c.key} className={c.className}>
              {c.text && c.filter !== 'none' && <ColumnFilter col={c} options={c.filter === 'enum' ? options(c) : []} value={g.state.filters[c.key] ?? ''} onChange={(v) => g.setFilter(c.key, v)} />}
            </th>
          ))}
        </tr>
      )}
    </thead>
  );
}

function gridCount(g: ReturnType<typeof useGridState>, n: number, total: number) {
  return g.filtered || g.state.sort ? (
    <span className="grid-count">
      {g.filtered && <span className="muted">{tr('{n} of {total}', { n, total })}</span>}
      <IconButton icon="clearFilter" title={tr('Reset filters and sorting')} onClick={g.reset} />
    </span>
  ) : null;
}

interface GridOptions<T> {
  /** Applies while no column sorts. */
  order?: (a: T, b: T) => number;
  /** Keeps a group together across pages, whatever the sort: rows go by this rank first. */
  group?: (r: T) => number;
}

/** `rows` is the current page, `all` every row that passes the filters. */
export function useGrid<T>(id: string, rows: T[], cols: Col<T>[], { order, group }: GridOptions<T> = {}) {
  const g = useGridState(id);
  const { state } = g;

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
    } else if (order) {
      out = [...out].sort(order);
    }
    return group ? [...out].sort((a, b) => group(a) - group(b)) : out;
  }, [rows, cols, state, order, group]);

  const { rows: pageRows, page } = pageSlice(shown, state.page, pageSizes.table);
  return {
    rows: pageRows,
    all: shown,
    page,
    pager: <Pager page={page} total={shown.length} size={pageSizes.table} onPage={g.setPage} />,
    head: gridHead(cols, g, (c) => [...new Set(rows.map(c.text!))].filter(Boolean).sort(collator.compare)),
    count: gridCount(g, shown.length, rows.length),
    filtered: g.filtered,
    colSpan: cols.length,
  };
}

/**
 * A grid over a list the service pages: filters, sorting and the page go to `load`. Column keys are those of the
 * query; `text` only marks a column as sortable and filterable. `reload` changes when the list may have changed.
 */
export function useServerGrid<T>(id: string, cols: Col<T>[], load: (q: PageQuery) => Promise<Page<T> | undefined>, reload: unknown) {
  const g = useGridState(id);
  const { state } = g;
  const [data, setData] = useState<Page<T> | null>(null);
  const size = pageSizes.table;

  useEffect(() => {
    let current = true;
    const filters = Object.fromEntries(Object.entries(state.filters).filter(([, v]) => v));
    void load({ offset: (state.page - 1) * size, limit: size, sort: state.sort ?? undefined, filters }).then((p) => {
      if (p && current) setData(p);
    });
    return () => {
      current = false;
    };
    // `load` is a new closure on every render; what it depends on arrives through `reload`.
  }, [state, size, reload]);

  const total = data?.total ?? 0;
  return {
    rows: data?.rows ?? [],
    pager: <Pager page={Math.floor((data?.offset ?? 0) / size) + 1} total={total} size={size} onPage={g.setPage} />,
    head: gridHead(cols, g, (c) => data?.options[c.key] ?? []),
    count: gridCount(g, total, data?.all ?? 0),
    filtered: g.filtered,
    colSpan: cols.length,
  };
}

function ColumnFilter<T>({ col, options, value, onChange }: { col: Col<T>; options: string[]; value: string; onChange: (v: string) => void }) {
  const label = tr('Filter: {column}', { column: typeof col.title === 'string' ? col.title : col.key });
  if (col.filter === 'enum') {
    return (
      <Select className={value ? 'col-filter set' : 'col-filter'} aria-label={label} value={value} onChange={onChange}>
        <option value="">{tr('all')}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {col.label?.(o) ?? o}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      className={value ? 'col-filter set' : 'col-filter'}
      type="search"
      aria-label={label}
      placeholder={col.placeholder ?? tr('search')}
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
