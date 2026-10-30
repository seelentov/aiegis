import type {
  CellStatus,
  DocVersionStatus,
  FindingStatus,
  InventoryStatus,
  JobStatus,
  PocOutcome,
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
import { locale, tr } from './i18n';

export const JOB_STATUS: Record<JobStatus, string> = {
  queued: tr('queued'),
  running: tr('running'),
  done: tr('done'),
  failed: tr('failed'),
  cancelled: tr('cancelled'),
  taken_over: tr('taken over'),
};

export const RUN_STATUS: Record<RunStatus, string> = {
  running: tr('in progress'),
  succeeded: tr('succeeded'),
  failed: tr('failed'),
  cancelled: tr('cancelled|run'),
  rate_limited: 'rate limit',
  token_limit: tr('token limit'),
  taken_over: tr('taken over|run'),
  exited: tr('exited'),
  interrupted: tr('interrupted'),
};

export function time(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function tokens(u: TokenUsage): string {
  const billable = u.input + u.cacheCreation + u.output;
  return billable >= 1000 ? `${(billable / 1000).toFixed(1)}k` : String(billable);
}

export function cost(u: TokenUsage): string {
  return u.costUsd ? `$${u.costUsd.toFixed(4)}` : '—';
}

export const CELL_STATUS: Record<CellStatus, string> = {
  not_checked: tr('not checked'),
  'n/a': 'n/a',
  pass: 'pass',
  finding: 'finding',
  needs_human: tr('needs human'),
};

export const STALE_REASON: Record<StaleReason, string> = { code: tr('code changed'), requirement: tr('requirement changed') };

export const FINDING_STATUS: Record<FindingStatus, string> = {
  suspected: tr('suspected'),
  verified: tr('verified'),
  false_positive: tr('false positive'),
  accepted_risk: tr('accepted risk'),
  fixed: tr('fixed'),
};

export const POC_OUTCOME: Record<PocOutcome, string> = {
  reproduced: tr('reproduced'),
  not_reproduced: tr('not reproduced'),
  inconclusive: tr('inconclusive'),
};

export const SEVERITY: Record<Severity, string> = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info' };

export const VERSION_STATUS: Record<DocVersionStatus, string> = {
  extracting: tr('extracting'),
  review: tr('in review'),
  approved: tr('approved'),
  failed: tr('extraction failed'),
  discarded: tr('discarded'),
};

export const REVIEW: Record<ReviewState, string> = { pending: tr('pending'), accepted: tr('accepted'), rejected: tr('rejected') };

export function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export const SIGNAL_KIND: Record<SignalKind, string> = { sast: tr('code (SAST)'), secret: tr('secret'), misconfig: tr('misconfiguration'), vuln: tr('vulnerable dependency') };

export const SCAN_STATUS: Record<ScanStatus, string> = { running: tr('in progress'), complete: tr('done'), failed: tr('failed') };

export const SUPPRESSION_SCOPE: Record<SuppressionScope, string> = {
  finding: tr('this finding'),
  rule_glob: tr('rule × glob'),
  requirement_module: tr('item × module'),
};

export const SUPPRESSION_STATE: Record<SuppressionState, string> = { active: tr('active'), stale: tr('stale'), expired: tr('expired'), revoked: tr('revoked') };

export const SCA_STATUS: Record<ScaItemStatus, string> = {
  not_checked: tr('not checked'),
  reachable: tr('reachable'),
  not_reachable: tr('not reachable'),
  needs_human: tr('needs human'),
};

export const INVENTORY_STATUS: Record<InventoryStatus, string> = { building: tr('building'), complete: tr('complete'), failed: tr('incomplete') };
