import { useEffect, useState } from 'react';
import type { ConfigFileInfo, EffectiveConfigView, ProjectInfo } from '../../shared/types';
import { api, errorText } from '../api';
import type { RunFn } from '../App';
import { ConfigForm, configSections } from './ConfigForm';
import { IconButton } from './Icon';
import { usePersisted } from './Splitter';
import { syncLanguage, tr } from '../i18n';

interface Props {
  project: ProjectInfo | null;
  run: RunFn;
  notify: (level: 'info' | 'warn' | 'error', text: string) => void;
}

/** Titles of config.yaml sections in the settings list; other sections show their key. */
const SECTION_TITLES: Record<string, string> = {
  '': tr('General'),
  ui: tr('Interface'),
  permissions: tr('Permissions'),
  env: tr('Environment variables'),
  claude: 'Claude Code',
  queue: tr('Queue'),
  limits: tr('Limits'),
  terminal: tr('Terminal'),
  sessions: tr('Sessions'),
  matrix: tr('Matrix'),
  findings: tr('Findings'),
  scanners: tr('Scanners'),
  signals: tr('Signals'),
  suppressions: tr('Suppressions'),
  sca: 'SCA',
  poc: tr('PoC tester'),
  tasks: tr('Tasks'),
  roles: tr('Roles'),
  modules: tr('Modules'),
  matrices: tr('Matrices'),
  requirements: tr('Requirements'),
};

/** An instruction file as a readable name: `instructions/roles/sca.md` -> `roles / sca`. */
function instructionName(rel: string): string {
  return rel.replace(/^instructions\//, '').replace(/\.md$/, '').split('/').join(' / ');
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
  const [mode, setMode] = usePersisted<'form' | 'yaml'>('settings.mode', 'form');
  const [section, setSection] = useState('');
  const [configTexts, setConfigTexts] = useState<Record<string, string>>({});

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

  // Saved config.yaml texts: their keys make the section list; a project config inherits the global one.
  useEffect(() => {
    const cfgs = files.filter((f) => f.rel === 'config.yaml');
    void run(Promise.all(cfgs.map((f) => (f.exists ? api.readConfigFile(pid, f.path) : Promise.resolve(''))))).then(
      (ts) => ts && setConfigTexts(Object.fromEntries(cfgs.map((f, i) => [f.path, ts[i]]))),
    );
  }, [files, pid, run]);
  const globalCfg = files.find((f) => f.scope === 'global' && f.rel === 'config.yaml')?.path;
  const projectCfg = files.some((f) => f.path === file && f.scope === 'project' && f.rel === 'config.yaml');
  const base = projectCfg && globalCfg ? configTexts[globalCfg] ?? null : null;

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
      notify('info', tr('Saved'));
      // A changed `ui.language` takes effect by reloading the page.
      if (file === globalCfg) syncLanguage(await api.uiLanguage());
      setRevision((r) => r + 1);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const dirty = text !== saved;
  const form = mode === 'form' && !!file?.endsWith('.yaml');
  const select = (path: string, s: string) => {
    if (path !== file && dirty && !confirm(tr('There are unsaved changes. Leave?'))) return;
    setFile(path);
    setSection(s);
  };
  const groups: { scope: ConfigFileInfo['scope']; title: string }[] = [
    { scope: 'global', title: tr('Global (~/.aiegis)') },
    ...(project ? [{ scope: 'project' as const, title: tr('Project ({name}/.aiegis)', { name: project.name }) }] : []),
  ];

  return (
    <div className="settings-tab">
      <div className="settings-files">
        {groups.map((g) => (
          <div key={g.scope}>
            <div className="section-title">{g.title}</div>
            {files
              .filter((f) => f.scope === g.scope && f.rel === 'config.yaml')
              .map((f) => (
                <ul key={f.path} className="file-list">
                  {(f.path === file ? configSections(globalCfg && configTexts[globalCfg], text) : configSections(globalCfg && configTexts[globalCfg], configTexts[f.path])).map((s) => (
                    <li
                      key={s}
                      className={f.path === file && (!form || s === section) ? 'active' : ''}
                      title={`${f.path}${s ? ` › ${s}` : ''}${f.exists ? '' : ` (${tr('no file yet, it is created on save')})`}`}
                      onClick={() => select(f.path, s)}
                    >
                      {SECTION_TITLES[s] ?? s}
                    </li>
                  ))}
                </ul>
              ))}
            <div className="section-title">{tr('Instructions')}</div>
            <ul className="file-list">
              {files
                .filter((f) => f.scope === g.scope && f.rel !== 'config.yaml')
                .map((f) => (
                  <li key={f.path} className={f.path === file ? 'active' : ''} title={f.path} onClick={() => select(f.path, '')}>
                    {instructionName(f.rel)}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="settings-editor">
        <div className="toolbar">
          <span className="mono small">{file}</span>
          {file?.endsWith('.yaml') && (
            <span className="toolbar-group">
              <button aria-pressed={mode === 'form'} onClick={() => setMode('form')}>
                {tr('Form')}
              </button>
              <button aria-pressed={mode === 'yaml'} onClick={() => setMode('yaml')}>
                YAML
              </button>
            </span>
          )}
          <button className="primary" disabled={!dirty} onClick={() => void save()}>
            {tr('Save')}
          </button>
          {file && <IconButton icon="external" title={tr('Open the file in an external editor')} onClick={() => void run(api.openInEditor(file))} />}
        </div>
        {form ? (
          <div className="settings-form">
            <ConfigForm text={text} base={base} section={section} onChange={setText} />
          </div>
        ) : (
          <textarea className="code" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        )}
        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="settings-effective">
        <div className="toolbar">
          <span>{tr('Effective configuration for role')}</span>
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
                <th>{tr('Field')}</th>
                <th>{tr('Value')}</th>
                <th>{tr('Source')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>agent</td>
                <td>{view.agent?.value ?? '—'}</td>
                <td className="muted">{view.agent?.source}</td>
              </tr>
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
