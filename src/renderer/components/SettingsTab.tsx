import { useEffect, useState } from 'react';
import type { ConfigFileInfo, EffectiveConfigView, ProjectInfo } from '../../shared/types';
import { api, errorText } from '../api';
import type { RunFn } from '../App';

interface Props {
  project: ProjectInfo | null;
  run: RunFn;
  notify: (level: 'info' | 'warn' | 'error', text: string) => void;
}

/** Last path segments of an instruction file, enough to recognize it. */
function tail(file: string): string {
  return file.split('/').slice(-3).join('/');
}

export function SettingsTab({ project, run, notify }: Props) {
  const pid = project?.id ?? null;
  const [files, setFiles] = useState<ConfigFileInfo[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<{ name: string; title: string }[]>([]);
  const [role, setRole] = useState('');
  const [view, setView] = useState<EffectiveConfigView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    void run(api.listConfigFiles(pid)).then((fs) => {
      if (!fs) return;
      setFiles(fs);
      setFile((cur) => (cur && fs.some((f) => f.path === cur) ? cur : fs[0]?.path ?? null));
    });
  }, [pid, run, revision]);

  useEffect(() => {
    if (!file) return;
    void run(api.readConfigFile(pid, file)).then((t) => {
      setText(t ?? '');
      setSaved(t ?? '');
      setError(null);
    });
  }, [file, pid, run]);

  useEffect(() => {
    api
      .listRoles(pid)
      .then((rs) => {
        setRoles(rs);
        setRole((cur) => (cur && rs.some((r) => r.name === cur) ? cur : rs[0]?.name ?? ''));
      })
      .catch((e) => setViewError(errorText(e)));
  }, [pid, revision]);

  useEffect(() => {
    if (!role) return;
    api
      .effectiveConfig(pid, role)
      .then((v) => (setView(v), setViewError(null)))
      .catch((e) => (setView(null), setViewError(errorText(e))));
  }, [pid, role, revision]);

  const save = async () => {
    if (!file) return;
    try {
      await api.writeConfigFile(pid, file, text);
      setSaved(text);
      setError(null);
      notify('info', 'Сохранено');
      setRevision((r) => r + 1);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const dirty = text !== saved;
  const groups: { scope: ConfigFileInfo['scope']; title: string }[] = [
    { scope: 'global', title: 'Глобальные (~/.aiegis)' },
    ...(project ? [{ scope: 'project' as const, title: `Проект (${project.name}/.aiegis)` }] : []),
  ];

  return (
    <div className="settings-tab">
      <div className="settings-files">
        {groups.map((g) => (
          <div key={g.scope}>
            <div className="section-title">{g.title}</div>
            <ul className="file-list">
              {files
                .filter((f) => f.scope === g.scope)
                .map((f) => (
                  <li
                    key={f.path}
                    className={f.path === file ? 'active' : ''}
                    title={f.path}
                    onClick={() => (!dirty || confirm('Есть несохранённые изменения. Перейти?')) && setFile(f.path)}
                  >
                    {f.rel}
                    {!f.exists && <span className="muted"> (нет, будет создан)</span>}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="settings-editor">
        <div className="toolbar">
          <span className="mono small">{file}</span>
          <button className="primary" disabled={!dirty} onClick={() => void save()}>
            Сохранить
          </button>
          {file && <button onClick={() => void run(api.openInEditor(file))}>В редакторе</button>}
        </div>
        <textarea className="code" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="settings-effective">
        <div className="toolbar">
          <span>Итоговая конфигурация для роли</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.title} ({r.name})
              </option>
            ))}
          </select>
        </div>
        {viewError && <div className="error-text">{viewError}</div>}
        {view && (
          <table className="grid compact">
            <thead>
              <tr>
                <th>Поле</th>
                <th>Значение</th>
                <th>Источник</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>model</td>
                <td>{view.model?.value ?? '—'}</td>
                <td className="muted">{view.model?.source}</td>
              </tr>
              <tr>
                <td>effort</td>
                <td>{view.effort?.value ?? '—'}</td>
                <td className="muted">{view.effort?.source}</td>
              </tr>
              {view.allow.map((a) => (
                <tr key={'a' + a.value}>
                  <td>allow</td>
                  <td className={a.denied ? 'strike mono' : 'mono'}>{a.value}</td>
                  <td className="muted">{a.source}</td>
                </tr>
              ))}
              {view.deny.map((d) => (
                <tr key={'d' + d.value}>
                  <td>deny</td>
                  <td className="mono">{d.value}</td>
                  <td className="muted">{d.source}</td>
                </tr>
              ))}
              {view.dirs.map((d) => (
                <tr key={'p' + d.value}>
                  <td>dir</td>
                  <td className="mono">{d.value}</td>
                  <td className="muted">{d.source}</td>
                </tr>
              ))}
              {view.env.map((e) => (
                <tr key={'e' + e.key}>
                  <td>env.{e.key}</td>
                  <td className="mono">{e.value}</td>
                  <td className="muted">{e.source}</td>
                </tr>
              ))}
              {view.instructions.map((i, n) => (
                <tr key={'i' + n}>
                  <td>instructions</td>
                  <td>
                    <details>
                      <summary className="mono small" title={i.file}>{i.file ? tail(i.file) : 'inline'}</summary>
                      <pre>{i.text}</pre>
                    </details>
                  </td>
                  <td className="muted">{i.source}</td>
                </tr>
              ))}
              {view.settings.map((s) => (
                <tr key={'s' + s.key}>
                  <td>{s.key}</td>
                  <td className="mono">{s.value}</td>
                  <td className="muted">{s.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
