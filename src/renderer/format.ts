import type {
  CellStatus,
  DocVersionStatus,
  FindingStatus,
  InventoryStatus,
  JobStatus,
  ReviewState,
  RunStatus,
  ScaItemStatus,
  ScanStatus,
  Severity,
  SignalKind,
  StaleReason,
  SuppressionScope,
  SuppressionState,
  TokenUsage,
} from '../shared/types';

export const JOB_STATUS: Record<JobStatus, string> = {
  queued: 'в очереди',
  running: 'выполняется',
  done: 'готово',
  failed: 'ошибка',
  cancelled: 'отменено',
  taken_over: 'перехвачено',
};

export const RUN_STATUS: Record<RunStatus, string> = {
  running: 'идёт',
  succeeded: 'успешно',
  failed: 'ошибка',
  cancelled: 'отменён',
  rate_limited: 'rate limit',
  token_limit: 'лимит токенов',
  taken_over: 'перехвачен',
  exited: 'завершён',
  interrupted: 'прерван',
};

export function time(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function tokens(u: TokenUsage): string {
  const billable = u.input + u.cacheCreation + u.output;
  return billable >= 1000 ? `${(billable / 1000).toFixed(1)}k` : String(billable);
}

export function cost(u: TokenUsage): string {
  return u.costUsd ? `$${u.costUsd.toFixed(4)}` : '—';
}

export const CELL_STATUS: Record<CellStatus, string> = {
  not_checked: 'не проверено',
  'n/a': 'n/a',
  pass: 'pass',
  finding: 'finding',
  needs_human: 'нужен человек',
};

export const STALE_REASON: Record<StaleReason, string> = { code: 'изменился код', requirement: 'изменилось требование' };

export const FINDING_STATUS: Record<FindingStatus, string> = {
  suspected: 'подозрение',
  verified: 'подтверждена',
  false_positive: 'ложное срабатывание',
  accepted_risk: 'риск принят',
  fixed: 'исправлена',
};

export const SEVERITY: Record<Severity, string> = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info' };

export const VERSION_STATUS: Record<DocVersionStatus, string> = {
  extracting: 'извлечение',
  review: 'на ревью',
  approved: 'утверждена',
  failed: 'ошибка извлечения',
  discarded: 'отброшена',
};

export const REVIEW: Record<ReviewState, string> = { pending: 'не просмотрен', accepted: 'принят', rejected: 'отклонён' };

export function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export const SIGNAL_KIND: Record<SignalKind, string> = { sast: 'код (SAST)', secret: 'секрет', misconfig: 'конфигурация', vuln: 'уязвимая зависимость' };

export const SCAN_STATUS: Record<ScanStatus, string> = { running: 'идёт', complete: 'готово', failed: 'ошибка' };

export const SUPPRESSION_SCOPE: Record<SuppressionScope, string> = {
  finding: 'эта находка',
  rule_glob: 'правило × glob',
  requirement_module: 'пункт × модуль',
};

export const SUPPRESSION_STATE: Record<SuppressionState, string> = { active: 'действует', stale: 'устарело', expired: 'истёк срок', revoked: 'отозвано' };

export const SCA_STATUS: Record<ScaItemStatus, string> = {
  not_checked: 'не проверено',
  reachable: 'достижима',
  not_reachable: 'не достижима',
  needs_human: 'нужен человек',
};

export const INVENTORY_STATUS: Record<InventoryStatus, string> = { building: 'строится', complete: 'готова', failed: 'неполная' };
