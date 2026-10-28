import type { JobStatus, RunStatus, TokenUsage } from '../shared/types';

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
