import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { usePersisted } from './Splitter';

/** A collapsible details-pane section; its open state is remembered per title, across entities. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = usePersisted(`section.${title}`, true);
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
