import type { TokenUsage } from '../../shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ev = Record<string, any>;

export interface StreamSummary {
  usage: TokenUsage;
  /** Set when the final `result` event arrived. */
  result?: { isError: boolean; subtype: string; text: string };
  /** Epoch ms when a rejected rate limit resets (if seen). */
  rateLimitResetsAt?: number;
  rateLimited: boolean;
}

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 });

/** Accumulates state from claude `--output-format stream-json` events. */
export class StreamTracker {
  private readonly perMessage = new Map<string, TokenUsage>();
  private final: TokenUsage | null = null;
  readonly summary: StreamSummary = { usage: emptyUsage(), rateLimited: false };

  feed(ev: Ev): void {
    if (ev.type === 'assistant' && ev.message?.usage) {
      const u = ev.message.usage;
      this.perMessage.set(ev.message.id ?? String(this.perMessage.size), {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        costUsd: 0,
      });
    } else if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {};
      if (info.status === 'rejected') {
        this.summary.rateLimited = true;
        if (typeof info.resetsAt === 'number') this.summary.rateLimitResetsAt = info.resetsAt * 1000;
      }
    } else if (ev.type === 'result') {
      const u = ev.usage ?? {};
      this.final = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        costUsd: ev.total_cost_usd ?? 0,
      };
      const text = typeof ev.result === 'string' ? ev.result : (ev.errors ?? []).join('; ');
      this.summary.result = { isError: Boolean(ev.is_error) || ev.subtype !== 'success', subtype: ev.subtype ?? '', text };
      if (this.summary.result.isError && /usage limit|rate limit/i.test(text)) this.summary.rateLimited = true;
    }
    this.summary.usage = this.final ?? this.sum();
  }

  private sum(): TokenUsage {
    const t = emptyUsage();
    for (const u of this.perMessage.values()) {
      t.input += u.input;
      t.output += u.output;
      t.cacheCreation += u.cacheCreation;
      t.cacheRead += u.cacheRead;
    }
    return t;
  }
}

/** Tokens counted against `limits.max_tokens_per_run` (cache reads excluded). */
export function billableTokens(u: TokenUsage): number {
  return u.input + u.cacheCreation + u.output;
}

/** Splits a byte stream into complete lines. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.filter((l) => l.trim().length > 0);
  }
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' };

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

const nl = (s: string) => s.replace(/\r?\n/g, '\r\n') + '\r\n';

/** Renders one stream-json event as terminal text for the read-only stream view. */
export function formatEvent(ev: Ev): string {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') return nl(`${C.dim}[init] model=${ev.model} session=${ev.session_id} cwd=${ev.cwd}${C.reset}`);
      return '';
    case 'assistant': {
      let out = '';
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text) out += nl(b.text);
        else if (b.type === 'thinking' && b.thinking) out += nl(`${C.dim}${clip(b.thinking, 300)}${C.reset}`);
        else if (b.type === 'tool_use') out += nl(`${C.cyan}→ ${b.name} ${clip(JSON.stringify(b.input ?? {}), 200)}${C.reset}`);
      }
      return out;
    }
    case 'user': {
      let out = '';
      const content = ev.message?.content;
      if (!Array.isArray(content)) return '';
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const text = Array.isArray(b.content) ? b.content.map((x: Ev) => x.text ?? '').join(' ') : String(b.content ?? '');
        out += nl(`${b.is_error ? C.red : C.dim}  ← ${clip(text, 300)}${C.reset}`);
      }
      return out;
    }
    case 'rate_limit_event': {
      const s = ev.rate_limit_info?.status;
      return s && s !== 'allowed' ? nl(`${C.yellow}[rate limit] ${s}${C.reset}`) : '';
    }
    case 'result': {
      const color = ev.is_error ? C.red : C.green;
      const u = ev.usage ?? {};
      return nl(
        `${color}[result] ${ev.subtype}${ev.is_error ? ' (error)' : ''} · in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} ` +
          `cache_w=${u.cache_creation_input_tokens ?? 0} cache_r=${u.cache_read_input_tokens ?? 0} · $${(ev.total_cost_usd ?? 0).toFixed(4)}${C.reset}`,
      );
    }
    default:
      return '';
  }
}
