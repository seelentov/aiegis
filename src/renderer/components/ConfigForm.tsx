import { useEffect, useMemo, useState, type ReactNode } from 'react';
import YAML, { isMap, isScalar, type Document } from 'yaml';
import { IconButton } from './Icon';
import { Section } from './Section';
import { tr } from '../i18n';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const at = (v: unknown, path: string[]) => path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), v);

/** The comment above a key in YAML source; it serves as the field hint. */
export function hintOf(doc: Document | null, path: string[]): string | undefined {
  const map = doc?.getIn(path.slice(0, -1), true);
  if (!isMap(map)) return undefined;
  const i = map.items.findIndex((p) => isScalar(p.key) && p.key.value === path.at(-1));
  if (i < 0) return undefined;
  // The comment above the first key of a nested map belongs to the map itself.
  const c = (map.items[i].key as { commentBefore?: string | null }).commentBefore ?? (i === 0 ? map.commentBefore : undefined);
  return c?.replace(/^ /gm, '') || undefined;
}

/** Sets (or, for `undefined`, removes) a value in YAML text, keeping comments and formatting of the rest. */
export function editYaml(text: string, path: string[], value: unknown): string {
  const doc = YAML.parseDocument(text);
  if (value === undefined) doc.deleteIn(path);
  else doc.setIn(path, value);
  return doc.toString();
}

/** Top-level sections of config texts, in file order: '' gathers plain values, every map is a section of its own. */
export function configSections(...texts: (string | null | undefined)[]): string[] {
  const keys = new Map<string, boolean>();
  for (const t of texts) {
    let js: unknown;
    try {
      js = YAML.parse(t ?? '');
    } catch {
      continue;
    }
    if (isObj(js)) for (const [k, v] of Object.entries(js)) if (!keys.has(k)) keys.set(k, isObj(v));
  }
  const entries = [...keys];
  return [...(entries.some(([, map]) => !map) ? [''] : []), ...entries.filter(([, map]) => map).map(([k]) => k)];
}

interface Props {
  /** YAML text of the edited config file. */
  text: string;
  /** Global config text when editing a project config: its values are inherited and shown as placeholders. */
  base: string | null;
  /** Top-level section to show (see `configSections`). */
  section: string;
  onChange: (text: string) => void;
}

/** config.yaml as a settings form: fields come from the file (and the inherited global config), not from code. */
export function ConfigForm({ text, base, section, onChange }: Props) {
  const doc = useMemo(() => YAML.parseDocument(text), [text]);
  const baseDoc = useMemo(() => (base === null ? null : YAML.parseDocument(base)), [base]);
  if (doc.errors.length) return <div className="error-text">{tr('YAML error: {message}. Fix it in YAML mode.', { message: doc.errors[0].message })}</div>;
  const own: unknown = doc.toJS();
  const inherited: unknown = baseDoc?.errors.length ? undefined : baseDoc?.toJS();

  const fields = (path: string[], only: (key: string) => boolean = () => true): ReactNode => {
    const o = at(own, path);
    const b = at(inherited, path);
    const keys = [...new Set([...Object.keys(isObj(b) ? b : {}), ...Object.keys(isObj(o) ? o : {})])];
    return keys.filter(only).map((k) => {
      const p = [...path, k];
      const ov = at(own, p);
      const bv = at(inherited, p);
      const hint = hintOf(doc, p) ?? hintOf(baseDoc, p);
      if (isObj(ov ?? bv))
        return (
          <Section key={k} title={k}>
            {hint && <div className="muted small config-hint">{hint}</div>}
            <div className="config-form">{fields(p)}</div>
          </Section>
        );
      return <Field key={k} name={k} hint={hint} own={ov} inherited={bv} onSet={(v) => onChange(editYaml(text, p, v))} />;
    });
  };

  if (section === '') return <div className="config-form">{fields([], (k) => !isObj(at(own, [k]) ?? at(inherited, [k])))}</div>;
  const hint = hintOf(doc, [section]) ?? hintOf(baseDoc, [section]);
  return (
    <>
      {hint && <div className="muted small config-hint config-section-hint">{hint}</div>}
      <div className="config-form">{fields([section])}</div>
    </>
  );
}

interface FieldProps {
  name: string;
  hint?: string;
  own: unknown;
  inherited: unknown;
  /** `undefined` removes the key: in a project config the global value applies again. */
  onSet: (value: unknown) => void;
}

function Field({ name, hint, own, inherited, onSet }: FieldProps) {
  const v = own ?? inherited;
  const inherits = inherited !== undefined;
  // Empty text in a project config means "inherit"; in the global one it is a value.
  const text = (s: string) => onSet(s === '' && inherits ? undefined : s);
  let input: ReactNode;
  if (typeof v === 'boolean') input = <input type="checkbox" checked={v} onChange={(e) => onSet(e.target.checked)} />;
  else if (typeof v === 'number')
    input = (
      <input
        type="number"
        value={typeof own === 'number' ? own : ''}
        placeholder={inherits ? String(inherited) : ''}
        onChange={(e) => onSet(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  else if (typeof v === 'string' && v.includes('\n'))
    input = <textarea rows={4} value={typeof own === 'string' ? own : ''} placeholder={inherits ? String(inherited) : ''} onChange={(e) => text(e.target.value)} />;
  else if (typeof v === 'string') input = <input value={typeof own === 'string' ? own : ''} placeholder={inherits ? String(inherited) : ''} onChange={(e) => text(e.target.value)} />;
  // A trailing empty item could not survive one-per-line editing.
  else if (Array.isArray(v) && v.at(-1) !== '' && v.every((x) => typeof x === 'string' || typeof x === 'number'))
    input = <ListField own={own as unknown[] | undefined} inherited={inherited as unknown[] | undefined} numbers={v.length > 0 && v.every((x) => typeof x === 'number')} onSet={onSet} />;
  else input = <span className="muted small">{tr('set in YAML mode')}</span>;

  return (
    <>
      <div className="config-label">
        <span className="mono">{name}</span>
        {hint && <div className="muted small config-hint">{hint}</div>}
      </div>
      <div className="config-input">{input}</div>
      {own !== undefined && inherits ? <IconButton icon="undo" title={tr('Restore the global value')} onClick={() => onSet(undefined)} /> : <span />}
    </>
  );
}

/** A list of scalars, one item per line. */
function ListField({ own, inherited, numbers, onSet }: { own?: unknown[]; inherited?: unknown[]; numbers: boolean; onSet: (v: unknown) => void }) {
  const joined = (own ?? []).join('\n');
  const [draft, setDraft] = useState(joined);
  // Only trailing blank lines are dropped: an empty argument inside a list (e.g. `--setting-sources ""`) is a value.
  const clean = (s: string) => s.replace(/\n+$/, '').split('\n').filter((l, _, a) => a.length > 1 || l !== '');
  // Keep the draft (with its trailing empty line while typing) unless the value changed elsewhere.
  useEffect(() => setDraft((d) => (clean(d).join('\n') === joined ? d : joined)), [joined]);
  return (
    <textarea
      rows={Math.min(8, Math.max(2, clean(draft).length + 1))}
      value={draft}
      placeholder={inherited ? `${inherited.join('\n')}` : tr('one value per line')}
      onChange={(e) => {
        setDraft(e.target.value);
        const items = clean(e.target.value).map((l) => (numbers && /^-?\d+$/.test(l.trim()) ? Number(l.trim()) : l));
        onSet(items.length === 0 && inherited !== undefined ? undefined : items);
      }}
    />
  );
}
