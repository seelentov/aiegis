import type { TokenUsage } from '../../shared/types';
import type { StreamSummary } from '../claude/stream';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ev = Record<string, any>;

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 });

/**
 * Accumulates state from `pi --mode json` events. pi exits with 0 even when the model call failed, so the outcome is
 * the stop reason of the last assistant message. Provider rate limits carry no reset time.
 */
export class PiStreamTracker {
  readonly summary: StreamSummary = { usage: emptyUsage(), rateLimited: false };

  feed(ev: Ev): void {
    const m = ev.message;
    if (ev.type !== 'message_end' || m?.role !== 'assistant') return;
    const u = m.usage ?? {};
    const t = this.summary.usage;
    t.input += u.input ?? 0;
    t.output += u.output ?? 0;
    t.cacheCreation += u.cacheWrite ?? 0;
    t.cacheRead += u.cacheRead ?? 0;
    t.costUsd += u.cost?.total ?? 0;
    const isError = m.stopReason === 'error' || m.stopReason === 'aborted';
    const text = isError
      ? String(m.errorMessage ?? m.stopReason)
      : (m.content ?? [])
          .filter((b: Ev) => b.type === 'text')
          .map((b: Ev) => b.text)
          .join('');
    this.summary.result = { isError, subtype: m.stopReason ?? '', text };
    if (isError && /usage limit|rate limit|\b429\b/i.test(text)) this.summary.rateLimited = true;
  }
}

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' };

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

const nl = (s: string) => s.replace(/\r?\n/g, '\r\n') + '\r\n';

/** Renders one pi JSON event as terminal text for the read-only stream view. */
export function formatPiEvent(ev: Ev): string {
  switch (ev.type) {
    case 'session':
      return nl(`${C.dim}[init] pi session=${ev.id} cwd=${ev.cwd}${C.reset}`);
    case 'message_end': {
      const m = ev.message ?? {};
      if (m.role !== 'assistant') return '';
      let out = '';
      for (const b of m.content ?? []) {
        if (b.type === 'text' && b.text) out += nl(b.text);
        else if (b.type === 'thinking' && b.thinking) out += nl(`${C.dim}${clip(b.thinking, 300)}${C.reset}`);
        else if (b.type === 'toolCall') out += nl(`${C.cyan}→ ${b.name} ${clip(JSON.stringify(b.arguments ?? {}), 200)}${C.reset}`);
      }
      if (m.stopReason === 'error' || m.stopReason === 'aborted') out += nl(`${C.red}[error] ${clip(String(m.errorMessage ?? m.stopReason), 500)}${C.reset}`);
      const u = m.usage ?? {};
      if (m.stopReason === 'stop')
        out += nl(`${C.green}[result] ${m.model ?? ''} · in=${u.input ?? 0} out=${u.output ?? 0} cache_w=${u.cacheWrite ?? 0} cache_r=${u.cacheRead ?? 0} · $${(u.cost?.total ?? 0).toFixed(4)}${C.reset}`);
      return out;
    }
    case 'tool_execution_end': {
      const text = (ev.result?.content ?? []).map((x: Ev) => x.text ?? '').join(' ');
      return nl(`${ev.isError ? C.red : C.dim}  ← ${clip(text, 300)}${C.reset}`);
    }
    case 'auto_retry_start':
      return nl(`${C.yellow}[retry ${ev.attempt}/${ev.maxAttempts}] ${clip(String(ev.errorMessage ?? ''), 200)}${C.reset}`);
    case 'compaction_start':
      return nl(`${C.dim}[compaction] ${ev.reason}${C.reset}`);
    default:
      return '';
  }
}
