import { describe, expect, it } from 'vitest';
import { checkDocPlan, parseGeneratedDoc } from '../src/main/documents';
import type { DocPlanEntry } from '../src/shared/types';

const entry = (o: Partial<DocPlanEntry>): DocPlanEntry => ({ slug: 'authn', title: 'Authn', key_prefix: 'AUTHN', scope: 's', modules: [], sections: ['A'], ...o });

describe('checkDocPlan', () => {
  it('accepts a plan covering all modules', () => {
    expect(() => checkDocPlan([entry({ modules: ['a'] }), entry({ slug: 'data', key_prefix: 'DATA', modules: ['b'] })], ['a', 'b'], [])).not.toThrow();
    expect(() => checkDocPlan([entry({})], ['a', 'b'], [])).not.toThrow();
  });
  it('rejects gaps, unknown modules, duplicates, bad ids and changed prefixes', () => {
    expect(() => checkDocPlan([entry({ modules: ['a'] })], ['a', 'b'], [])).toThrow(/not covered.*b/);
    expect(() => checkDocPlan([entry({ modules: ['c'] })], ['a'], [])).toThrow(/unknown modules c/);
    expect(() => checkDocPlan([entry({}), entry({ key_prefix: 'X1' })], [], [])).toThrow(/duplicate slug/);
    expect(() => checkDocPlan([entry({ slug: 'Bad Slug' })], [], [])).toThrow(/kebab-case/);
    expect(() => checkDocPlan([entry({ key_prefix: 'a' })], [], [])).toThrow(/uppercase/);
    expect(() => checkDocPlan([entry({ sections: [] })], [], [])).toThrow(/no sections/);
    expect(() => checkDocPlan([entry({ key_prefix: 'AUTH' })], [], [entry({})])).toThrow(/keeps its key_prefix AUTHN/);
    expect(() => checkDocPlan([entry({ slug: 'other' })], [], [entry({})])).toThrow(/belongs to the generated document authn/);
    expect(() => checkDocPlan([], [], [])).toThrow(/no documents/);
  });
});

describe('parseGeneratedDoc', () => {
  it('parses requirement lines under sections and ignores prose', () => {
    const md = '# Authn\n\nScope - **not** a requirement.\n\n## Login\n\n- **AUTHN-1** Login must be rate limited.\n  Why: brute force.\n* **AUTHN-2:** Passwords must be hashed.\n\n## Sessions\n- **AUTHN-10**: Sessions must expire.\n';
    expect(parseGeneratedDoc(md, 'AUTHN')).toEqual({
      title: 'Authn',
      items: [
        { key: 'AUTHN-1', text: 'Login must be rate limited.', section: 'Login' },
        { key: 'AUTHN-2', text: 'Passwords must be hashed.', section: 'Login' },
        { key: 'AUTHN-10', text: 'Sessions must expire.', section: 'Sessions' },
      ],
    });
  });
  it('rejects documents the review could not use', () => {
    expect(() => parseGeneratedDoc('## A\n- **AUTHN-1** x', 'AUTHN')).toThrow(/Title/);
    expect(() => parseGeneratedDoc('# T\n- **AUTHN-1** x', 'AUTHN')).toThrow(/not under/);
    expect(() => parseGeneratedDoc('# T\n## A\n- **DATA-1** x', 'AUTHN')).toThrow(/start with AUTHN-/);
    expect(() => parseGeneratedDoc('# T\n## A\n- **AUTHN-1** x\n- **AUTHN-1** y', 'AUTHN')).toThrow(/duplicate/);
    expect(() => parseGeneratedDoc('# T\n## A\ntext', 'AUTHN')).toThrow(/no requirements/);
  });
});
