import { useEffect, useState } from 'react';
import type { DocumentSummary, DocVersionView, ItemChange, ProjectInfo, RequirementItem } from '../../shared/types';
import { api } from '../api';
import type { RunFn } from '../App';
import { JOB_STATUS, REVIEW, time, VERSION_STATUS } from '../format';

interface Props {
  project: ProjectInfo;
  revision: number;
  run: RunFn;
  onTerminal: (id: string | undefined) => void;
}

const CHANGE: Record<ItemChange, string> = { added: 'новый', changed: 'изменён', same: '' };

type ItemDraft = { key: string; text: string; section: string; quote: string };

function ItemForm({ item, onSave, onCancel }: { item?: RequirementItem; onSave: (d: ItemDraft) => void; onCancel: () => void }) {
  const [d, setD] = useState<ItemDraft>({ key: item?.key ?? '', text: item?.text ?? '', section: item?.section ?? '', quote: item?.quote ?? '' });
  const set = (k: keyof ItemDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <div className="form">
      <label>
        Id (пусто — сгенерировать)
        <input value={d.key} onChange={set('key')} disabled={Boolean(item)} />
      </label>
      <label>
        Раздел
        <input value={d.section} onChange={set('section')} />
      </label>
      <label className="wide">
        Требование
        <textarea rows={2} value={d.text} onChange={set('text')} />
      </label>
      <label className="wide">
        Цитата-источник
        <textarea rows={2} value={d.quote} onChange={set('quote')} />
      </label>
      <div className="wide row">
        <button className="primary" disabled={!d.text.trim()} onClick={() => onSave(d)}>
          Сохранить (принят)
        </button>
        <button onClick={onCancel}>Отмена</button>
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
  const shown = view.items.filter((i) => filter === 'all' || (filter === 'pending' ? i.review === 'pending' : i.change !== 'same'));

  return (
    <div>
      <div className="toolbar">
        <strong>
          {view.document.title} · v{v.n}
        </strong>
        <span className={`status v-${v.status}`}>{VERSION_STATUS[v.status]}</span>
        <span className="muted">
          {v.filename} · {time(v.createdAt)} · пунктов {v.itemCount}
          {v.pendingCount ? `, не просмотрено ${v.pendingCount}` : ''}
          {view.baseline ? ` · сравнение с v${view.baseline.n}` : ''}
        </span>
        {view.sourceFile && <button onClick={() => void run(api.openInEditor(view.sourceFile!))}>Файл</button>}
        {view.job?.lastRunId && <button onClick={() => void run(api.openRun(project.id, view.job!.lastRunId!)).then(onTerminal)}>Сессия</button>}
      </div>
      {view.job && (active || view.job.error) && (
        <div className="muted">
          Извлечение: {JOB_STATUS[view.job.status]}
          {view.job.error && <span className="error-text"> — {view.job.error}</span>}
        </div>
      )}
      {!view.quotesVerified && <div className="warn">PDF читается Claude напрямую: цитаты не сверяются с текстом приложением — проверьте их при ревью.</div>}
      <div className="toolbar">
        {editable && (
          <>
            <button disabled={!v.pendingCount} onClick={() => review(view.items.filter((i) => i.review === 'pending').map((i) => i.id), 'accepted')}>
              Принять все непросмотренные
            </button>
            <button onClick={() => setEditing('new')}>+ Пункт вручную</button>
            <button className="primary" disabled={v.status !== 'review' || v.pendingCount > 0} onClick={() => void run(api.approveVersion(project.id, v.id))}>
              Утвердить версию
            </button>
          </>
        )}
        {(v.status === 'failed' || (v.status === 'extracting' && !active)) && (
          <>
            <button onClick={() => void run(api.retryExtraction(project.id, v.id))}>Повторить извлечение</button>
            {v.itemCount > 0 && <button onClick={() => void run(api.setVersionState(project.id, v.id, 'review'))}>Перейти к ревью</button>}
          </>
        )}
        {v.status !== 'approved' && v.status !== 'discarded' && !active && (
          <button onClick={() => confirm('Отбросить версию? Её пункты не попадут в матрицы.') && void run(api.setVersionState(project.id, v.id, 'discarded'))}>
            Отбросить
          </button>
        )}
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">все пункты</option>
          <option value="pending">не просмотренные</option>
          <option value="changed">новые и изменённые</option>
        </select>
      </div>
      {editing === 'new' && (
        <div className="card">
          <ItemForm onSave={(d) => void save(d)} onCancel={() => setEditing(null)} />
        </div>
      )}
      <table className="grid req-grid">
        <thead>
          <tr>
            <th>Id</th>
            <th>Раздел</th>
            <th>Требование / цитата</th>
            <th>Ревью</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                {active ? 'Пункты появятся по мере извлечения…' : 'Пунктов нет'}
              </td>
            </tr>
          )}
          {shown.map((i) =>
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
                      <button disabled={i.review === 'accepted'} onClick={() => review([i.id], 'accepted')}>
                        Принять
                      </button>
                      <button disabled={i.review === 'rejected'} onClick={() => review([i.id], 'rejected')}>
                        Отклонить
                      </button>
                      <button onClick={() => setEditing(i.id)}>Изменить</button>
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
                <div className="status c-removed">удалён</div>
              </td>
              <td>{i.section}</td>
              <td>{i.text}</td>
              <td colSpan={2} className="muted">
                нет в новой версии
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
        <input placeholder="название документа (по умолчанию — имя файла)" value={title} onChange={(e) => setTitle(e.target.value)} size={40} />
        <button className="primary" onClick={() => void importFile()}>
          Загрузить документ (MD, PDF, DOCX)
        </button>
      </div>
      <table className="grid compact">
        <thead>
          <tr>
            <th>Документ</th>
            <th>Текущая версия</th>
            <th>Версии</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {docs.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Документов нет — загрузите стандарт или внутренний гайдлайн
              </td>
            </tr>
          )}
          {docs.map((d) => (
            <tr key={d.id}>
              <td>
                <strong>{d.title}</strong>
              </td>
              <td>{d.current ? `v${d.current.n} · ${d.current.itemCount} пунктов` : <span className="muted">не утверждена</span>}</td>
              <td>
                {d.versions.map((v) => (
                  <a key={v.id} className={v.id === versionId ? 'version active' : 'version'} onClick={() => setVersionId(v.id)}>
                    v{v.n} <span className="muted small">{VERSION_STATUS[v.status]}</span>
                  </a>
                ))}
              </td>
              <td className="actions">
                <button onClick={() => void importFile(d.id)}>Новая версия</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view && <VersionReview project={project} view={view} run={run} onTerminal={onTerminal} />}
    </div>
  );
}
