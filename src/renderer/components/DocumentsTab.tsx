import { useEffect, useState } from 'react';
import type { DocumentSummary, DocVersionView, ItemChange, ProjectInfo, RequirementItem } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { JOB_STATUS, REVIEW, time, VERSION_STATUS } from '../format';
import { EmptyRow, useGrid } from './Grid';
import { IconButton } from './Icon';
import { tr } from '../i18n';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  onTerminal: (id: string | undefined) => void;
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
                  {i.quote && <div className="muted small quote">«{i.quote}»</div>}
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

export function DocumentsTab({ project, revision, run, onTerminal }: Props) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [view, setView] = useState<DocVersionView | null>(null);
  const [title, setTitle] = useState('');

  useEffect(() => {
    void run(api.listDocuments(project.id)).then((d) => d && setDocs(d));
  }, [project.id, revision, run]);

  useEffect(() => {
    if (!versionId) return setView(null);
    void run(api.docVersion(project.id, versionId)).then((v) => setView(v ?? null));
  }, [project.id, versionId, revision, run]);

  const g = useGrid('documents', docs, [
    { key: 'title', title: tr('Document'), text: (d) => d.title },
    { key: 'current', title: tr('Current version'), text: (d) => (d.current ? `v${d.current.n}` : tr('not approved')), filter: 'enum' },
    { key: 'versions', title: tr('Versions') },
    { key: 'actions', title: '', className: 'actions' },
  ]);

  const importFile = async (documentId?: string) => {
    const file = await run(api.pickDocumentFile());
    if (!file) return;
    const v = await run(api.importDocument(project.id, file, { documentId, title: documentId ? undefined : title }));
    if (v) {
      setTitle('');
      setVersionId(v.version.id);
    }
  };

  return (
    <div className="documents-tab">
      <div className="toolbar">
        <input placeholder={tr('document title (file name by default)')} value={title} onChange={(e) => setTitle(e.target.value)} size={40} />
        <IconButton icon="upload" className="primary" title={tr('Upload a document: MD, PDF or DOCX')} label={tr('Upload document')} onClick={() => void importFile()} />
        {g.count}
      </div>
      <table className="grid compact">
        {g.head}
        <tbody>
          {g.rows.length === 0 && (
            <EmptyRow colSpan={g.colSpan} filtered={g.filtered}>
              {tr('No documents: upload a standard or an internal guideline')}
            </EmptyRow>
          )}
          {g.rows.map((d) => (
            <tr key={d.id}>
              <td>
                <strong>{d.title}</strong>
              </td>
              <td>{d.current ? `v${d.current.n} · ${tr('items {n}', { n: d.current.itemCount })}` : <span className="muted">{tr('not approved')}</span>}</td>
              <td>
                {d.versions.map((v) => (
                  <a key={v.id} className={v.id === versionId ? 'version active' : 'version'} onClick={() => setVersionId(v.id)}>
                    v{v.n} <span className="muted small">{VERSION_STATUS[v.status]}</span>
                  </a>
                ))}
              </td>
              <td className="actions">
                <IconButton icon="filePlus" title={tr('Upload a new version')} onClick={() => void importFile(d.id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view && <VersionReview project={project} view={view} run={run} onTerminal={onTerminal} />}
    </div>
  );
}
