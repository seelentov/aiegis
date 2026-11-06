import type { Evidence, Severity, VerdictStatus } from '../shared/types';

/** One session of a branch check; its id is the job id. */
export const DIFF_BATCH_ENTITY = 'diff_batch';
/** One requirement of a branch check: what a session may write. */
export const DIFF_ITEM_ENTITY = 'diff_item';

export const diffItemId = (checkId: string, itemId: string) => `${checkId}/${itemId}`;

/** Why a verdict of a branch check cannot be saved (SPEC §26); null when it can. */
export function diffVerdictError(files: string[], status: VerdictStatus, severity: Severity | undefined, evidence: Evidence[]): string | null {
  if (status !== 'n/a' && !evidence.length) return `${status} requires code references (evidence)`;
  if (status !== 'finding') return null;
  if (!severity) return 'finding requires a severity';
  return evidence.some((e) => files.includes(e.file)) ? null : 'a finding must cite at least one file the branch changes: what is not in the diff is not caused by it';
}
