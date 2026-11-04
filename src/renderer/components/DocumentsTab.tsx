import { Fragment, useEffect, useState } from 'react';
import type { DocCheckStatus, DocLink, DocProposal, DocProposalKind, DocRefreshEstimate, DocRefreshTarget, DocSet, DocumentSummary, DocVersionView, ItemChange, Matrix, ProjectInfo, RequirementItem } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { JOB_STATUS, kTokens, REVIEW, time, VERSION_STATUS } from '../format';
import type { Selection } from './DetailsPanel';
import { EmptyRow, useGrid } from './Grid';
import { IconButton } from './Icon';
import { tr } from '../i18n';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  onTerminal: (id: string | undefined) => void;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  notify: (level: 'info' | 'warn' | 'error', text: string) => void;
}

const CHANGE: Record<ItemChange, string> = { added: tr('new|item'), changed: tr('changed|item'), same: '' };

type ItemDraft = { key: string; text: string; section: string; quote: string };

function ItemForm({ item, onSave, onCancel }: { item?: RequirementItem; onSave: (d: ItemDraft) => void; onCancel: () => void }) {
  const [d, setD] = useState<ItemDraft>({ key: item?.key ?? '', text: item?.text ?? '', section: item?.section ?? '', quote: item?.quote ?? '' });
  const set = (k: keyof ItemDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <div className="form">
      <label>
        {tr('Id (empty to generate)')}
        <input value={d.key} onChange={set('key')} disabled={Boolean(item)} />
      </label>
      <label>
        {tr('Section')}
        <input value={d.section} onChange={set('section')} />
      </label>
      <label className="wide">
        {tr('Requirement')}
        <textarea rows={2} value={d.text} onChange={set('text')} />
      </label>
      <label className="wide">
        {tr('Source quote')}
        <textarea rows={2} value={d.quote} onChange={set('quote')} />
      </label>
      <div className="wide row">
        <button className="primary" disabled={!d.text.trim()} onClick={() => onSave(d)}>
          {tr('Save (accepted)')}
        </button>
        <button onClick={onCancel}>{tr('Cancel')}</button>
      </div>
    </div>
  );
}

/** Review of one document version: mandatory before its requirements reach matrices (SPEC §4, Q17). */
function VersionReview({ project, view, run, onTerminal }: { project: ProjectInfo; view: DocVersionView; run: RunFn; onTerminal: Props['onTerminal'] }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'changed'>('all');
  const v = view.version;
  const editable = v.status === 'review' || v.status === 'failed';
  const active = view.job && (view.job.status === 'queued' || view.job.status === 'running');
  const review = (ids: string[], r: RequirementItem['review']) => void run(api.reviewItems(project.id, v.id, ids, r));
  const save = async (d: ItemDraft) => {
    const ok = await run(api.saveItem(project.id, v.id, { key: d.key.trim() || null, text: d.text, section: d.section, quote: d.quote }));
    if (ok) setEditing(null);
  };
  const g = useGrid(
    'documents.items',
    view.items.filter((i) => filter === 'all' || (filter === 'pending' ? i.review === 'pending' : i.change !== 'same')),
    [
      { key: 'key', title: 'Id', text: (i) => `${i.key} ${CHANGE[i.change]}`, sort: (i) => i.key },
      { key: 'section', title: tr('Section'), text: (i) => i.section, filter: 'enum' },
      { key: 'text', title: tr('Requirement / quote'), text: (i) => `${i.text} ${i.quote ?? ''}`, sort: (i) => i.text },
      { key: 'review', title: tr('Review'), text: (i) => REVIEW[i.review], filter: 'enum' },
      { key: 'actions', title: '', className: 'actions' },
    ],
  );

  return (
    <div>
      <div className="toolbar">
        <strong>
          {view.document.title} · v{v.n}
        </strong>
        <span className={`status v-${v.status}`}>{VERSION_STATUS[v.status]}</span>
        <span className="muted">
          {v.filename} · {time(v.createdAt)} · {tr('items {n}', { n: v.itemCount })}
          {v.pendingCount ? `, ${tr('pending {n}', { n: v.pendingCount })}` : ''}
          {view.baseline ? ` · ${tr('compared with v{n}', { n: view.baseline.n })}` : ''}
        </span>
        {view.sourceFile && <IconButton icon="file" title={tr('Open the source file')} onClick={() => void run(api.openInEditor(view.sourceFile!))} />}
        {view.job?.lastRunId && (
          <IconButton icon="terminal" title={tr('Open the extraction session')} onClick={() => void run(api.openRun(project.id, view.job!.lastRunId!)).then(onTerminal)} />
        )}
      </div>
      {view.job && (active || view.job.error) && (
        <div className="muted">
          {tr('Extraction: {status}', { status: JOB_STATUS[view.job.status] })}
          {view.job.error && <span className="error-text"> — {view.job.error}</span>}
        </div>
      )}
      {view.proposal?.restored && <div className="warn">{RESTORED(view.proposal)}</div>}
      {view.proposal?.unverifiedChannel && <div className="warn">{UNVERIFIED()}</div>}
      {!view.quotesVerified && <div className="warn">{tr('Claude reads the PDF directly: the app does not match quotes against the text, check them during review.')}</div>}
      <div className="toolbar">
        {editable && (
          <>
            <IconButton
              icon="checkAll"
              title={tr('Accept all pending items')}
              label={`${tr('Accept all')} ${v.pendingCount || ''}`}
              disabled={!v.pendingCount}
              onClick={() => review(view.items.filter((i) => i.review === 'pending').map((i) => i.id), 'accepted')}
            />
            <IconButton icon="plus" title={tr('Add an item manually')} label={tr('Item')} onClick={() => setEditing('new')} />
            <IconButton
              icon="approve"
              className="primary"
              title={v.pendingCount > 0 ? tr('Review all items first') : tr('Approve the version: its items go to matrices')}
              label={tr('Approve')}
              disabled={v.status !== 'review' || v.pendingCount > 0}
              onClick={() => void run(api.approveVersion(project.id, v.id))}
            />
          </>
        )}
        {(v.status === 'failed' || (v.status === 'extracting' && !active)) && (
          <>
            <IconButton icon="retry" title={tr('Retry requirement extraction')} label={tr('Extract again')} onClick={() => void run(api.retryExtraction(project.id, v.id))} />
            {v.itemCount > 0 && (
              <IconButton icon="checkAll" title={tr('Go to the review of extracted items')} label={tr('To review')} onClick={() => void run(api.setVersionState(project.id, v.id, 'review'))} />
            )}
          </>
        )}
        {v.status !== 'approved' && v.status !== 'discarded' && !active && (
          <IconButton
            icon="reject"
            className="danger"
            title={tr('Discard the version')}
            onClick={() => confirm(tr('Discard the version? Its items will not go to matrices.')) && void run(api.setVersionState(project.id, v.id, 'discarded'))}
          />
        )}
        <select aria-label={tr('Items')} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">{tr('all items')}</option>
          <option value="pending">{tr('pending items')}</option>
          <option value="changed">{tr('new and changed')}</option>
        </select>
        {g.count}
      </div>
      {editing === 'new' && (
        <div className="card">
          <ItemForm onSave={(d) => void save(d)} onCancel={() => setEditing(null)} />
        </div>
      )}
      <table className="grid req-grid">
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {active ? tr('Items appear as they are extracted…') : tr('No items')}
            </EmptyRow>
          )}
          {g.rows.map((i) =>
            editing === i.id ? (
              <tr key={i.id} className="expanded">
                <td colSpan={5}>
                  <ItemForm item={i} onSave={(d) => void save({ ...d, key: i.key })} onCancel={() => setEditing(null)} />
                </td>
              </tr>
            ) : (
              <tr key={i.id} className={`review-${i.review}`}>
                <td className="mono">
                  {i.key}
                  {CHANGE[i.change] && <div className={`status c-${i.change}`}>{CHANGE[i.change]}</div>}
                </td>
                <td>{i.section}</td>
                <td>
                  <div>{i.text}</div>
                  {i.quote && i.quote !== i.text && <div className="muted small quote">«{i.quote}»</div>}
                  <div className="muted small">{i.author}</div>
                </td>
                <td>{REVIEW[i.review]}</td>
                <td className="actions">
                  {editable && (
                    <>
                      <IconButton icon="check" className="ok" title={tr('Accept')} aria-pressed={i.review === 'accepted'} disabled={i.review === 'accepted'} onClick={() => review([i.id], 'accepted')} />
                      <IconButton icon="reject" className="danger" title={tr('Reject')} aria-pressed={i.review === 'rejected'} disabled={i.review === 'rejected'} onClick={() => review([i.id], 'rejected')} />
                      <IconButton icon="edit" title={tr('Edit')} onClick={() => setEditing(i.id)} />
                    </>
                  )}
                </td>
              </tr>
            ),
          )}
          {view.removed.map((i) => (
            <tr key={i.id} className="removed">
              <td className="mono">
                {i.key}
                <div className="status c-removed">{tr('removed|item')}</div>
              </td>
              <td>{i.section}</td>
              <td>{i.text}</td>
              <td colSpan={2} className="muted">
                {tr('not in the new version')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CHECK: Record<DocCheckStatus, { label: string; cls: string }> = {
  current: { label: tr('current|document'), cls: 'cs-pass' },
  changed: { label: tr('change found'), cls: 'cs-needs_human' },
  unverifiable: { label: tr('could not check'), cls: 'cs-not_checked' },
};
const KIND: Record<DocProposalKind, string> = { update: tr('New edition'), add: tr('Add document'), replace: tr('Replaced by another'), retire: tr('Out of force'), link: tr('Link found') };
const UNVERIFIED = () => tr('Received over an unverified channel: plain HTTP or no certificate check. Anyone on the path could have changed it.');
const RESTORED = (p: DocProposal) => tr('The text was rewritten by AI because the page converted badly; {n}% of its paragraphs were found on the page. Compare it with the source.', { n: Math.round((p.coverage ?? 0) * 100) });

function LinkFields({ link, onChange, onRemove }: { link: DocLink; onChange: (l: DocLink) => void; onRemove?: () => void }) {
  return (
    <div className="wide row">
      <input className="grow" value={link.url} placeholder="https://" onChange={(e) => onChange({ ...link, url: e.target.value })} />
      <label className="check" title={tr('For a site whose certificate cannot be verified. Anyone on the path could change what is downloaded; results get a warning.')}>
        <input type="checkbox" checked={link.insecure} onChange={(e) => onChange({ ...link, insecure: e.target.checked })} />
        {tr('Do not verify the certificate')}
      </label>
      {onRemove && <IconButton icon="trash" title={tr('Remove the link')} onClick={onRemove} />}
    </div>
  );
}

function DocSetForm({ project, run, set, docs, onDone }: { project: ProjectInfo; run: RunFn; set?: DocSet; docs: DocumentSummary[]; onDone: () => void }) {
  const [name, setName] = useState(set?.name ?? '');
  const [scope, setScope] = useState(set?.scope ?? '');
  const [links, setLinks] = useState<DocLink[]>(set?.links ?? []);
  const [ids, setIds] = useState(docs.filter((d) => set && d.setId === set.id).map((d) => d.id));
  const save = async () => {
    const r = await run(api.saveDocSet(project.id, { id: set?.id, name, scope, links: links.filter((l) => l.url.trim()), documentIds: ids }));
    if (r) onDone();
  };
  return (
    <div className="form">
      <label>
        {tr('Title')}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div />
      <label className="wide">
        {tr('What belongs to this set: AI judges new documents by it')}
        <textarea rows={2} value={scope} onChange={(e) => setScope(e.target.value)} />
      </label>
      <fieldset className="wide">
        <legend>{tr('Links to check')}</legend>
        <span className="muted small">{tr('Links of individual documents are not used when the whole set is checked.')}</span>
        {links.map((l, i) => (
          <LinkFields key={i} link={l} onChange={(x) => setLinks(links.map((o, n) => (n === i ? x : o)))} onRemove={() => setLinks(links.filter((_, n) => n !== i))} />
        ))}
        <div className="row">
          <IconButton icon="plus" title={tr('Add a link')} label={tr('Add a link')} onClick={() => setLinks([...links, { url: '', insecure: false }])} />
        </div>
      </fieldset>
      <fieldset className="wide">
        <legend>{tr('Documents of the set')}</legend>
        {docs.map((d) => (
          <label key={d.id} className="check">
            <input type="checkbox" checked={ids.includes(d.id)} onChange={(e) => setIds(e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id))} />
            {d.title}
          </label>
        ))}
      </fieldset>
      <div className="wide row">
        <button className="primary" disabled={!name.trim()} onClick={() => void save()}>
          {tr('Save')}
        </button>
        <button onClick={onDone}>{tr('Cancel')}</button>
        {set && (
          <button onClick={() => confirm(tr('Remove the set? Its documents stay, outside any set.')) && void run(api.removeDocSet(project.id, set.id)).then(onDone)}>
            {tr('Remove the set')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Details of a refresher proposal in the right panel: the evidence and the decision. */
export function DocProposalDetailsView({ project, id, revision, run, onSelect }: { project: ProjectInfo; id: string; revision: number; run: RunFn; onSelect: (s: Selection | null) => void }) {
  const [p, setP] = useState<DocProposal | null>(null);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [matrices, setMatrices] = useState<Matrix[]>([]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  useEffect(() => {
    void run(Promise.all([api.listDocProposals(project.id), api.listDocuments(project.id), api.listMatrices(project.id)])).then((r) => {
      if (!r) return;
      setP(r[0].find((x) => x.id === id) ?? null);
      setDocs(r[1]);
      setMatrices(r[2]);
    });
  }, [project.id, id, revision, run]);
  if (!p) return null;
  const doc = docs.find((d) => d.id === p.documentId);
  const setDocIds = docs.filter((d) => d.setId === p.setId).map((d) => d.id);
  const picked = chosen ?? matrices.filter((m) => m.documentIds.some((d) => setDocIds.includes(d))).map((m) => m.id);
  const open = doc?.versions.find((v) => v.status === 'extracting' || v.status === 'review');
  const blocked = p.kind === 'update' && open ? tr('The document has an unapproved version v{n}: approve or discard it first', { n: open.n }) : null;
  const decided = p.status !== 'pending';
  return (
    <section>
      <h3>{KIND[p.kind]}</h3>
      <dl>
        <dt>{tr('Document')}</dt>
        <dd>{p.title ?? doc?.title ?? '—'}</dd>
        {p.edition && (
          <>
            <dt>{tr('Edition')}</dt>
            <dd>{p.edition}</dd>
          </>
        )}
        <dt>{tr('Reason')}</dt>
        <dd>{p.reason}</dd>
        {p.quote && (
          <>
            <dt>{tr('Source quote')}</dt>
            <dd>{p.quote}</dd>
          </>
        )}
        {p.url && (
          <>
            <dt>{tr('Source')}</dt>
            <dd className="mono small">{p.url}</dd>
          </>
        )}
        {p.quoteUrl && p.quoteUrl !== p.url && (
          <>
            <dt>{tr('Quote from')}</dt>
            <dd className="mono small">{p.quoteUrl}</dd>
          </>
        )}
        {decided && p.decisionNote && (
          <>
            <dt>{tr('Decision')}</dt>
            <dd>{p.decisionNote}</dd>
          </>
        )}
      </dl>
      {p.unverifiedChannel && <div className="warn">{UNVERIFIED()}</div>}
      {p.restored && <div className="warn">{RESTORED(p)}</div>}
      {blocked && <div className="warn">{blocked}</div>}
      {!decided && (
        <div className="form">
          {p.kind === 'add' && matrices.length > 0 && (
            <fieldset className="wide">
              <legend>{tr('Add to matrices (cells appear once it is approved)')}</legend>
              {matrices.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setChosen(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
                  {m.name}
                </label>
              ))}
            </fieldset>
          )}
          <div className="wide row">
            <IconButton
              icon="approve"
              className="primary"
              disabled={Boolean(blocked)}
              title={tr('Apply: a new document or version goes to extraction and review')}
              label={tr('Apply')}
              onClick={() => void run(api.acceptDocProposal(project.id, p.id, { matrixIds: p.kind === 'add' ? picked : undefined })).then((r) => r && onSelect(null))}
            />
            <IconButton icon="reject" title={tr('Reject: it is not proposed again while the source stays the same')} label={tr('Reject')} onClick={() => void run(api.rejectDocProposal(project.id, p.id, '')).then(() => onSelect(null))} />
          </div>
        </div>
      )}
    </section>
  );
}

export function DocumentsTab({ project, revision, run, onTerminal, selection, onSelect, notify }: Props) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [sets, setSets] = useState<DocSet[]>([]);
  const [proposals, setProposals] = useState<DocProposal[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [view, setView] = useState<DocVersionView | null>(null);
  const [title, setTitle] = useState('');
  const [uploadSet, setUploadSet] = useState('');
  const [hint, setHint] = useState('');
  const [setForm, setSetForm] = useState<DocSet | 'new' | null>(null);
  const [sourceOf, setSourceOf] = useState<{ doc: DocumentSummary; link: DocLink } | null>(null);
  const [retiring, setRetiring] = useState<{ doc: DocumentSummary; reason: string } | null>(null);
  const [pendingCheck, setPendingCheck] = useState<{ target: DocRefreshTarget; name: string; estimate: DocRefreshEstimate } | null>(null);

  useEffect(() => {
    void run(Promise.all([api.listDocuments(project.id), api.listDocSets(project.id), api.listDocProposals(project.id)])).then((r) => {
      if (!r) return;
      setDocs(r[0]);
      setSets(r[1]);
      setProposals(r[2]);
    });
  }, [project.id, revision, run]);

  useEffect(() => {
    if (!versionId) return setView(null);
    void run(api.docVersion(project.id, versionId)).then((v) => setView(v ?? null));
  }, [project.id, versionId, revision, run]);

  const g = useGrid('documents', docs, [
    { key: 'title', title: tr('Document'), text: (d) => d.title },
    { key: 'current', title: tr('Current version'), text: (d) => (d.current ? `v${d.current.n}` : tr('not approved')), filter: 'enum' },
    { key: 'versions', title: tr('Versions') },
    { key: 'check', title: tr('Last check'), text: (d) => (d.retiredAt ? tr('out of force') : d.lastCheck ? CHECK[d.lastCheck.status].label : tr('not checked')), filter: 'enum' },
    { key: 'actions', title: '', className: 'actions' },
  ]);

  const importFile = async (documentId?: string) => {
    const file = await run(api.pickDocumentFile());
    if (!file) return;
    const v = await run(api.importDocument(project.id, file, documentId ? { documentId } : { title, setId: uploadSet || undefined }));
    if (v) {
      setTitle('');
      setVersionId(v.version.id);
    }
  };

  const generate = async () => {
    if (await run(api.enqueueDocPlan(project.id, hint))) setHint('');
  };

  const askCheck = async (target: DocRefreshTarget, name: string) => {
    const estimate = await run(api.estimateDocRefresh(project.id, target));
    if (estimate) setPendingCheck({ target, name, estimate });
  };

  const startCheck = async (force: boolean) => {
    if (!pendingCheck) return;
    const { target, name } = pendingCheck;
    setPendingCheck(null);
    const r = await run(api.refreshDocuments(project.id, target, { force }));
    if (!r) return;
    if (r.failed.length) notify('warn', tr('“{name}”: could not reach {urls}', { name, urls: r.failed.map((f) => `${f.url} (${f.error})`).join('; ') }));
    else if (!r.job) notify('info', tr('“{name}”: the sources did not change, no AI was used', { name }));
    else notify('info', tr('“{name}”: the check is queued', { name }));
  };

  const pending = proposals.filter((p) => p.status === 'pending');
  const groups: { set: DocSet | null; rows: DocumentSummary[] }[] = [
    ...sets.map((set) => ({ set, rows: g.rows.filter((d) => d.setId === set.id) })),
    { set: null, rows: g.rows.filter((d) => !d.setId) },
  ];

  return (
    <div className="documents-tab">
      <div className="toolbar">
        <input placeholder={tr('document title (file name by default)')} value={title} onChange={(e) => setTitle(e.target.value)} size={40} />
        <select value={uploadSet} title={tr('Set of the uploaded document')} onChange={(e) => setUploadSet(e.target.value)}>
          <option value="">{tr('Without a set')}</option>
          {sets.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <IconButton icon="upload" className="primary" title={tr('Upload a document: MD, PDF or DOCX')} label={tr('Upload document')} onClick={() => void importFile()} />
        <IconButton icon="folderPlus" title={tr('Create a document set to check against its links')} label={tr('New set')} onClick={() => setSetForm('new')} />
        {g.count}
      </div>
      {setForm && (
        <div className="card">
          <strong>{setForm === 'new' ? tr('New set') : setForm.name}</strong>
          <DocSetForm key={setForm === 'new' ? 'new' : setForm.id} project={project} run={run} set={setForm === 'new' ? undefined : setForm} docs={docs} onDone={() => setSetForm(null)} />
        </div>
      )}
      {sourceOf && (
        <div className="card">
          <strong>{tr('Link of “{title}”', { title: sourceOf.doc.title })}</strong>
          <div className="form">
            <LinkFields link={sourceOf.link} onChange={(link) => setSourceOf({ ...sourceOf, link })} />
            <div className="wide row">
              <button className="primary" onClick={() => void run(api.setDocumentSource(project.id, sourceOf.doc.id, sourceOf.link.url.trim() ? sourceOf.link : null)).then(() => setSourceOf(null))}>
                {tr('Save')}
              </button>
              <button onClick={() => setSourceOf(null)}>{tr('Cancel')}</button>
            </div>
          </div>
        </div>
      )}
      {retiring && (
        <div className="card">
          <strong>{tr('Take “{title}” out of force', { title: retiring.doc.title })}</strong>
          <div className="form">
            <label className="wide">
              {tr('Reason')}
              <input value={retiring.reason} onChange={(e) => setRetiring({ ...retiring, reason: e.target.value })} />
            </label>
            <div className="wide row">
              <button className="primary" disabled={!retiring.reason.trim()} onClick={() => void run(api.retireDocument(project.id, retiring.doc.id, retiring.reason)).then(() => setRetiring(null))}>
                {tr('Save')}
              </button>
              <button onClick={() => setRetiring(null)}>{tr('Cancel')}</button>
            </div>
          </div>
        </div>
      )}
      {pendingCheck && (
        <div className="card estimate">
          <strong>{tr('Estimate: {title} (role {role})', { title: pendingCheck.name, role: pendingCheck.estimate.role })}</strong>
          <div>
            {tr('Documents: {docs} · links: {links} · ≈{tokens} tokens ({source}) · limit per run {max}', {
              docs: pendingCheck.estimate.documents,
              links: pendingCheck.estimate.links.length,
              tokens: kTokens(pendingCheck.estimate.tokens),
              source: pendingCheck.estimate.tokensSource === 'history' ? tr('from run history') : tr('from config'),
              max: kTokens(pendingCheck.estimate.maxTokensPerRun),
            })}
          </div>
          <div className="muted">{tr('If the sources did not change since the last check, no AI is used and no tokens are spent.')}</div>
          <div className="row">
            <IconButton icon="play" className="primary" title={tr('Compare the sources first; the agent runs only if they changed')} label={tr('Run')} onClick={() => void startCheck(false)} />
            <IconButton icon="wand" title={tr('Run the agent even if the sources look unchanged')} label={tr('Run with AI anyway')} onClick={() => void startCheck(true)} />
            <button onClick={() => setPendingCheck(null)}>{tr('Cancel')}</button>
          </div>
        </div>
      )}
      <details className="card" open={docs.length === 0}>
        <summary>{tr('Write security documents with AI')}</summary>
        <div className="form">
          <label className="wide">
            {tr('Hints (optional): focus, standards to follow, document language; also used by “Rewrite”')}
            <textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} />
          </label>
          <IconButton
            icon="wand"
            className="primary"
            title={tr('AI plans documents that cover the whole application, then writes each one; every document goes to review')}
            label={tr('Write documents')}
            onClick={() => void generate()}
          />
        </div>
      </details>
      <table className="grid compact">
        {g.head}
        <tbody>
          {g.rows.length === 0 && !sets.length && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {tr('No documents: upload a standard or an internal guideline')}
            </EmptyRow>
          )}
          {groups.map(({ set, rows }) => {
            const own = pending.filter((p) => (set ? p.setId === set.id : !p.setId));
            if (!set && !rows.length && !own.length) return null;
            const members = docs.filter((d) => (set ? d.setId === set.id : !d.setId));
            return (
              <Fragment key={set?.id ?? 'none'}>
                <tr className="section-row">
                  <td colSpan={g.colSpan}>
                    <span>{set ? set.name : tr('Without a set')}</span>
                    <span> · {tr('documents {n}', { n: members.length })}</span>
                    {own.length > 0 && <span> · {tr('proposals {n}', { n: own.length })}</span>}
                    {set && (
                      <>
                        <IconButton icon="recheck" className="ghost row-run" disabled={!set.links.length} title={set.links.length ? tr('Check the set against its links') : tr('The set has no links')} onClick={() => void askCheck({ setId: set.id }, set.name)} />
                        {!members.length && own.some((p) => p.kind === 'add') && <IconButton icon="checkAll" className="ghost row-run" title={tr('First filling of an empty set: apply all additions')} onClick={() => void run(api.acceptAllDocAdditions(project.id, set.id))} />}
                        <IconButton icon="sliders" className="ghost row-run" title={tr('Set: name, links, documents')} onClick={() => setSetForm(set)} />
                      </>
                    )}
                  </td>
                </tr>
                {own.map((p) => (
                  <tr key={p.id} className={selection?.kind === 'doc-proposal' && selection.id === p.id ? 'selected' : ''} onClick={() => onSelect({ kind: 'doc-proposal', id: p.id })}>
                    <td colSpan={g.colSpan}>
                      <span className="status cs-needs_human">{KIND[p.kind]}</span> <strong>{p.title ?? docs.find((d) => d.id === p.documentId)?.title}</strong>
                      {p.edition && <span className="muted"> · {p.edition}</span>}
                      {p.unverifiedChannel && <span className="warn small"> · {tr('unverified channel')}</span>}
                      {p.url && <div className="mono small muted">{p.url}</div>}
                    </td>
                  </tr>
                ))}
                {rows.map((d) => (
                  <tr key={d.id} className={d.retiredAt ? 'removed' : ''}>
                    <td title={d.generated?.scope}>
                      <strong>{d.title}</strong>
                      {d.generated && <span className="muted small"> · {tr('AI · {prefix}', { prefix: d.generated.key_prefix })}</span>}
                      {d.edition && <div className="muted small">{d.edition}</div>}
                      {d.source && <div className="mono small muted">{d.source.url}</div>}
                    </td>
                    <td>{d.current ? `v${d.current.n} · ${tr('items {n}', { n: d.current.itemCount })}` : <span className="muted">{tr('not approved')}</span>}</td>
                    <td>
                      {d.versions.map((v) => (
                        <a key={v.id} className={v.id === versionId ? 'version active' : 'version'} onClick={() => setVersionId(v.id)}>
                          v{v.n} <span className="muted small">{VERSION_STATUS[v.status]}</span>
                        </a>
                      ))}
                    </td>
                    <td title={d.retiredAt ? (d.retiredReason ?? undefined) : d.lastCheck?.note}>
                      {d.retiredAt ? (
                        <>
                          <span className="status cs-na">{tr('out of force')}</span>
                          {d.retiredReason && <div className="muted small">{d.retiredReason}</div>}
                        </>
                      ) : d.lastCheck ? (
                        <>
                          <span className={`status ${CHECK[d.lastCheck.status].cls}`}>{CHECK[d.lastCheck.status].label}</span> <span className="muted small">{time(d.lastCheck.at)}</span>
                          {d.lastCheck.status !== 'current' && <div className="muted small">{d.lastCheck.note}</div>}
                          {d.lastCheck.unverifiedChannel && <div className="warn small">{tr('unverified channel')}</div>}
                        </>
                      ) : (
                        <span className="status cs-not_checked">{tr('not checked')}</span>
                      )}
                    </td>
                    <td className="actions">
                      {!d.retiredAt && <IconButton icon="recheck" disabled={!d.source} title={d.source ? tr('Check this document against its link') : tr('The document has no link')} onClick={() => void askCheck({ documentId: d.id }, d.title)} />}
                      <IconButton icon="link" title={tr('Link of the document')} onClick={() => setSourceOf({ doc: d, link: d.source ?? { url: '', insecure: false } })} />
                      {d.retiredAt ? (
                        <IconButton icon="undo" title={tr('Back into force: requirements return to matrices')} onClick={() => void run(api.restoreDocument(project.id, d.id))} />
                      ) : (
                        <IconButton icon="close" title={tr('Out of force: leaves matrices and checks, history stays')} onClick={() => setRetiring({ doc: d, reason: '' })} />
                      )}
                      {d.generated && (
                        <IconButton icon="wand" title={tr('Rewrite with AI: a new version for review')} onClick={() => void run(api.regenerateDocument(project.id, d.id, hint))} />
                      )}
                      <IconButton icon="filePlus" title={tr('Upload a new version')} onClick={() => void importFile(d.id)} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {view && <VersionReview project={project} view={view} run={run} onTerminal={onTerminal} />}
    </div>
  );
}
