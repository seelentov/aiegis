import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';
import { usePersisted } from './Splitter';
import { api } from '../api';
import { lang, tr } from '../i18n';
import { copyText, FILE_LINE, ProjectIdContext, showMenu } from '../menu';
import { useReveal } from '../reveal';
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
  // Unlike filters, hidden columns are remembered across restarts, as column layout is in VS Code.
  const [hidden, setHidden] = usePersisted<string[]>(`grid.${id}.hidden`, []);
  const head = useRef<HTMLTableSectionElement>(null);
  return {
    id,
    state,
    hidden,
    setHidden,
    head,
    filtered: Object.values(state.filters).some(Boolean),
    setPage: (page: number) => setState((s) => ({ ...s, page })),
    setFilter: (key: string, v: string) => setState((s) => ({ ...s, page: 1, filters: { ...s.filters, [key]: v } })),
    setSort: (sort: GridState['sort']) => setState((s) => ({ ...s, page: 1, sort })),
    toggleSort: (key: string) => setState((s) => ({ ...s, page: 1, sort: s.sort?.key !== key ? { key, dir: 1 } : s.sort.dir === 1 ? { key, dir: -1 } : null })),
    reset: () => setState({ sort: null, filters: {}, page: 1 }),
  };
}

type GridHandle = ReturnType<typeof useGridState>;

const colName = <T,>(c: Col<T>) => (typeof c.title === 'string' && c.title ? c.title : c.key);

// One stylesheet hides the hidden columns of every grid by cell position; cells spanning columns stay.
const hiddenCols = new Map<string, number[]>();
let hiddenSheet: HTMLStyleElement | null = null;
function setHiddenCols(id: string, idx: number[]) {
  if (idx.length) hiddenCols.set(id, idx);
  else hiddenCols.delete(id);
  hiddenSheet ??= document.head.appendChild(document.createElement('style'));
  hiddenSheet.textContent = [...hiddenCols]
    .flatMap(([g, list]) => list.map((i) => `table[data-grid="${CSS.escape(g)}"] > * > tr > :nth-child(${i + 1}):not([colspan])`))
    .join(',\n')
    .concat(hiddenCols.size ? ' { display: none; }' : '');
}

/** Menus of the header and the rows, column hiding: wired on the table that holds the grid's head. */
function useGridTable<T>(g: GridHandle, cols: Col<T>[], options: (c: Col<T>) => string[]) {
  const pid = useContext(ProjectIdContext);
  const latest = useRef({ cols, options, g, pid });
  latest.current = { cols, options, g, pid };

  const hiddenIdx = cols.flatMap((c, i) => (g.hidden.includes(c.key) ? [i] : []));
  useEffect(() => {
    setHiddenCols(g.id, hiddenIdx);
    return () => setHiddenCols(g.id, []);
  }, [g.id, hiddenIdx.join()]);

  useEffect(() => {
    const table = g.head.current?.closest('table');
    if (!table) return;
    table.dataset.grid = g.id;
    const onMenu = (e: MouseEvent) => {
      const { cols, options, g, pid } = latest.current;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, button, a')) return;
      if (target.closest('thead')) return headMenu(e, cols, g);
      const row = target.closest('tr');
      if (!row || row.parentElement?.tagName !== 'TBODY' || row.classList.contains('empty-row')) return;
      const cell = target.closest('td');
      // Columns map to cells only in a full row: grouped or expanded rows span several.
      const ci = cell && row.cells.length === cols.length ? cell.cellIndex : -1;
      const col = ci >= 0 ? cols[ci] : undefined;
      const value = cell?.innerText.trim() ?? '';
      const filterValue = col?.text && col.filter !== 'none' ? (col.filter === 'enum' ? options(col).find((o) => (col.label?.(o) ?? o) === value) : value) : undefined;
      const file = [...value.matchAll(FILE_LINE)][0];
      const rowText = (r: HTMLTableRowElement) => [...r.cells].filter((c) => c.offsetParent !== null).map((c) => c.innerText.trim().replace(/\s+/g, ' ')).join('\t');
      showMenu(e, [
        { label: tr('Open'), run: () => row.click() },
        file && { label: tr('Open {file} in the editor', { file: file[0].slice(file[1].length) }), run: () => void api.openInEditor(file[2], Number(file[3]), pid ?? undefined) },
        null,
        { label: tr('Copy the value'), enabled: value !== '', run: () => copyText(value) },
        { label: tr('Copy the row'), run: () => copyText(rowText(row)) },
        {
          label: tr('Copy the visible rows'),
          run: () => copyText([...table.querySelectorAll<HTMLTableRowElement>(':scope > thead > tr:first-child, :scope > tbody > tr:not(.empty-row)')].map(rowText).join('\n')),
        },
        null,
        col && filterValue !== undefined && filterValue !== '' && { label: tr('Filter by this value'), run: () => g.setFilter(col.key, filterValue) },
        col && { label: tr('Hide the column “{column}”', { column: colName(col) }), run: () => g.setHidden([...g.hidden, col.key]) },
      ]);
    };
    table.addEventListener('contextmenu', onMenu);
    return () => table.removeEventListener('contextmenu', onMenu);
  }, [g.id]);
}

function headMenu<T>(e: MouseEvent, cols: Col<T>[], g: GridHandle) {
  const th = (e.target as HTMLElement).closest('th');
  const col = th && th.parentElement === g.head.current?.rows[0] ? cols[th.cellIndex] : undefined;
  const shown = cols.filter((c) => !g.hidden.includes(c.key));
  showMenu(e, [
    col?.text && { label: tr('Sort ascending'), checked: g.state.sort?.key === col.key && g.state.sort.dir === 1, run: () => g.setSort({ key: col.key, dir: 1 }) },
    col?.text && { label: tr('Sort descending'), checked: g.state.sort?.key === col.key && g.state.sort.dir === -1, run: () => g.setSort({ key: col.key, dir: -1 }) },
    { label: tr('Reset filters and sorting'), enabled: g.filtered || g.state.sort !== null, run: g.reset },
    null,
    // The last shown column cannot be hidden.
    ...cols.map((c) => ({
      label: colName(c),
      checked: !g.hidden.includes(c.key),
      enabled: g.hidden.includes(c.key) || shown.length > 1,
      run: () => g.setHidden(g.hidden.includes(c.key) ? g.hidden.filter((k) => k !== c.key) : [...g.hidden, c.key]),
    })),
    g.hidden.length > 0 && { label: tr('Show all columns'), run: () => g.setHidden([]) },
  ]);
}

function gridHead<T>(cols: Col<T>[], g: GridHandle, options: (c: Col<T>) => string[]) {
  return (
    <thead ref={g.head as RefObject<HTMLTableSectionElement>} title={tr('Right-click: sorting and columns')}>
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

function gridCount(g: GridHandle, n: number, total: number) {
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
  /** Key of the row for `reveal` (`kind:id`): search and history bring it into view. */
  revealKey?: (r: T) => string;
}

/** `rows` is the current page, `all` every row that passes the filters. */
export function useGrid<T>(id: string, rows: T[], cols: Col<T>[], { order, group, revealKey }: GridOptions<T> = {}) {
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
  const options = (c: Col<T>) => [...new Set(rows.map(c.text!))].filter(Boolean).sort(collator.compare);
  useGridTable(g, cols, options);

  // Reveal: the row's page, with the filters dropped when they hide it, then the scroll once that page renders.
  const [flash, setFlash] = useState<string | null>(null);
  useReveal(
    (key) => {
      if (!revealKey) return false;
      const i = shown.findIndex((r) => revealKey(r) === key);
      if (i < 0) {
        if (g.filtered && rows.some((r) => revealKey(r) === key)) g.reset();
        return false;
      }
      g.setPage(Math.floor(i / pageSizes.table) + 1);
      setFlash(key);
      return true;
    },
    [shown],
  );
  useEffect(() => {
    if (flash === null) return;
    setFlash(null);
    // A row marks itself with `data-key` when nothing selects it; a selected row is found by its class.
    const body = g.head.current?.closest('table')?.tBodies[0];
    const el = body?.querySelector<HTMLTableRowElement>(`tr[data-key="${CSS.escape(flash)}"]`) ?? body?.querySelector<HTMLTableRowElement>('tr.selected');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }, [flash, page]);

  return {
    rows: pageRows,
    all: shown,
    page,
    pager: <Pager page={page} total={shown.length} size={pageSizes.table} onPage={g.setPage} />,
    head: gridHead(cols, g, options),
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
  // shortcut: no reveal here, as the service pages the list; search opens the details only. Add an offset lookup when needed.
  const options = (c: Col<T>) => data?.options[c.key] ?? [];
  useGridTable(g, cols, options);
  return {
    rows: data?.rows ?? [],
    pager: <Pager page={Math.floor((data?.offset ?? 0) / size) + 1} total={total} size={size} onPage={g.setPage} />,
    head: gridHead(cols, g, options),
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

/** ↑/↓ over the rows of the section's table that has a selected row: the next row is clicked (opening its details) and scrolled to. */
export function moveRowSelection(dir: 1 | -1): boolean {
  const cur = document.querySelector<HTMLTableRowElement>('.content table.grid > tbody > tr.selected');
  if (!cur) return false;
  let next = (dir === 1 ? cur.nextElementSibling : cur.previousElementSibling) as HTMLTableRowElement | null;
  while (next && (next.classList.contains('expanded') || next.classList.contains('empty-row'))) {
    next = (dir === 1 ? next.nextElementSibling : next.previousElementSibling) as HTMLTableRowElement | null;
  }
  if (!next) return false;
  next.click();
  next.scrollIntoView({ block: 'nearest' });
  return true;
}
