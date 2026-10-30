import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { tr } from '../i18n';

/** A layout size remembered in this viewer's browser; storage may be unavailable, the default then holds. */
export function usePersisted<T>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(`aiegis.${key}`);
      return s === null ? def : (JSON.parse(s) as T);
    } catch {
      return def;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`aiegis.${key}`, JSON.stringify(v));
    } catch {
      /* layout memory is a convenience */
    }
  }, [key, v]);
  return [v, setV];
}

interface Props {
  /** `x` resizes a width (vertical bar), `y` a height (horizontal bar). */
  axis: 'x' | 'y';
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  /** The panel sits after the bar (right or below), so dragging towards it shrinks it. */
  invert?: boolean;
  /** Double-click restores this size. */
  reset: number;
  label: string;
}

export function Splitter({ axis, value, onChange, min, max, invert, reset, label }: Props) {
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const origin = axis === 'x' ? e.clientX : e.clientY;
    const v0 = value;
    const move = (ev: globalThis.PointerEvent) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - origin;
      onChange(clamp(v0 + (invert ? -d : d)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing', `resizing-${axis}`);
    };
    document.body.classList.add('resizing', `resizing-${axis}`);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = axis === 'x' ? (invert ? 'ArrowLeft' : 'ArrowRight') : invert ? 'ArrowUp' : 'ArrowDown';
    const shrink = axis === 'x' ? (invert ? 'ArrowRight' : 'ArrowLeft') : invert ? 'ArrowDown' : 'ArrowUp';
    const step = e.shiftKey ? 64 : 16;
    if (e.key === grow) onChange(clamp(value + step));
    else if (e.key === shrink) onChange(clamp(value - step));
    else return;
    e.preventDefault();
  };
  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title={tr('{label}: drag, double-click to reset', { label })}
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={key}
    />
  );
}
