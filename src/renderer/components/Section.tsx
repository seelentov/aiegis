import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';
import { usePersisted } from './Splitter';

const ALL_SECTIONS = 'aiegis:sections';

/** Opens or collapses every section of the details pane (each remembers the state under its title). */
export function setAllSections(open: boolean): void {
  window.dispatchEvent(new CustomEvent<boolean>(ALL_SECTIONS, { detail: open }));
}

/** A collapsible details-pane section; its open state is remembered per title, across entities. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = usePersisted(`section.${title}`, true);
  useEffect(() => {
    const f = (e: Event) => setOpen((e as CustomEvent<boolean>).detail);
    window.addEventListener(ALL_SECTIONS, f);
    return () => window.removeEventListener(ALL_SECTIONS, f);
  }, []);
  return (
    <details className="pane-section" open={open} onToggle={(e) => e.currentTarget.open !== open && setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name="chevronRight" size={14} />
        <h4>{title}</h4>
      </summary>
      {children}
    </details>
  );
}
