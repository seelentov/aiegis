import type { EffectiveConfigView } from '../../shared/types';

/** Effective configuration with the source of every value (SPEC §3). */
export function ConfigView({ config, title }: { config: EffectiveConfigView; title: string }) {
  return (
    <details>
      <summary>{title}</summary>
      <dl>
        <dt>Роль</dt>
        <dd>{config.role.name}</dd>
        {config.model && (
          <>
            <dt>model</dt>
            <dd>
              {config.model.value} <span className="muted">← {config.model.source}</span>
            </dd>
          </>
        )}
        {config.effort && (
          <>
            <dt>effort</dt>
            <dd>
              {config.effort.value} <span className="muted">← {config.effort.source}</span>
            </dd>
          </>
        )}
        <dt>Инструкции</dt>
        <dd>
          {config.instructions.map((i, n) => (
            <div key={n} className="muted small">
              {i.source}
              {i.file ? `: ${i.file.split('/').slice(-2).join('/')}` : ''}
            </div>
          ))}
        </dd>
        <dt>allow</dt>
        <dd className="mono small">
          {config.allow.map((a) => (
            <div key={a.value} className={a.denied ? 'strike' : ''} title={a.source}>
              {a.value}
            </div>
          ))}
        </dd>
      </dl>
    </details>
  );
}
