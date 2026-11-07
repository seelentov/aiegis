import type { ComponentProps, ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';

export { Select } from './Select';

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'ok';

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ') || undefined;

type ButtonProps = ComponentProps<'button'> & { variant?: ButtonVariant; loading?: boolean };

/** `type="button"` by default; `loading` shows a spinner and blocks the click. */
export function Button({ variant, loading, className, disabled, children, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} disabled={disabled || loading} aria-busy={loading || undefined} className={classes(variant, loading && 'btn-icon-label', className)}>
      {loading && (
        <span className="spin">
          <Icon name="recheck" size={14} />
        </span>
      )}
      {children}
    </button>
  );
}

type IconButtonProps = ButtonProps & { icon: IconName; title: string; label?: ReactNode };

/** A button whose icon carries the meaning; `title` is its tooltip and accessible name, `label` adds visible text. */
export function IconButton({ icon, title, label, className, children: _children, ...rest }: IconButtonProps) {
  return (
    <Button {...rest} title={title} aria-label={label ? undefined : title} className={classes(label ? 'btn-icon-label' : 'btn-icon', className)}>
      {!rest.loading && <Icon name={icon} />}
      {label && <span>{label}</span>}
    </Button>
  );
}

type InputProps = Omit<ComponentProps<'input'>, 'type'> & { type?: 'text' | 'search' | 'number' | 'date' | 'password' | 'url' };

/** A text-like field. Paths, ids and commits are the usual content, so spell checking is off. */
export function Input(props: InputProps) {
  return <input spellCheck={false} {...props} />;
}

export function Textarea(props: ComponentProps<'textarea'>) {
  return <textarea {...props} />;
}

export function Checkbox(props: Omit<ComponentProps<'input'>, 'type'>) {
  return <input {...props} type="checkbox" />;
}

export function Radio(props: Omit<ComponentProps<'input'>, 'type'>) {
  return <input {...props} type="radio" />;
}

/** Horizontal rules only, the row is the unit; `useGrid` adds sorting and filters to its head. */
export function Table({ compact, className, ...rest }: ComponentProps<'table'> & { compact?: boolean }) {
  return <table {...rest} className={classes('grid', compact && 'compact', className)} />;
}
