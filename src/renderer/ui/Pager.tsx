import { useRef, useState, type ReactNode } from 'react';
import { IconButton } from '.';
import { tr } from '../i18n';

/** Rows per page, `ui.page_size` and `ui.history_page_size` of the global config once it has been read. */
export const pageSizes = { table: 50, history: 20 };
export const setPageSizes = (s: typeof pageSizes) => void Object.assign(pageSizes, s);

/** The rows of a page. A page past the end, after filtering or removal, becomes the last one. */
export function pageSlice<T>(items: T[], page: number, size: number): { rows: T[]; page: number } {
  const last = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), last);
  return { rows: items.slice((current - 1) * size, current * size), page: current };
}

/** Nothing when everything fits on one page. Shows the start of the new page, the element right before the pager. */
export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (page: number) => void }) {
  const nav = useRef<HTMLElement>(null);
  if (total <= size) return null;
  const last = Math.ceil(total / size);
  const go = (p: number) => {
    onPage(p);
    nav.current?.previousElementSibling?.scrollIntoView({ block: 'start' });
  };
  return (
    <nav ref={nav} className="pager" aria-label={tr('Pages')}>
      <IconButton icon="chevronsLeft" variant="ghost" title={tr('First page')} disabled={page === 1} onClick={() => go(1)} />
      <IconButton icon="chevronLeft" variant="ghost" title={tr('Previous page')} disabled={page === 1} onClick={() => go(page - 1)} />
      <span className="muted small num">{tr('{from}–{to} of {total}', { from: (page - 1) * size + 1, to: Math.min(page * size, total), total })}</span>
      <IconButton icon="chevronRight" variant="ghost" title={tr('Next page')} disabled={page === last} onClick={() => go(page + 1)} />
      <IconButton icon="chevronsRight" variant="ghost" title={tr('Last page')} disabled={page === last} onClick={() => go(last)} />
    </nav>
  );
}

/** A paged list for details panels. Give it a `key` of the shown entity: another entity starts from the first page. */
export function Paged<T>({ items, children }: { items: T[]; children: (item: T, index: number) => ReactNode }) {
  const [wanted, setWanted] = useState(1);
  const { rows, page } = pageSlice(items, wanted, pageSizes.history);
  return (
    <>
      <div>{rows.map(children)}</div>
      <Pager page={page} total={items.length} size={pageSizes.history} onPage={setWanted} />
    </>
  );
}
