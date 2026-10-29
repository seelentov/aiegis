import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backgroundCommand, interactiveCommand, shellQuote } from '../src/main/claude/args';
import { billableTokens, formatEvent, LineSplitter, StreamTracker } from '../src/main/claude/stream';
import { ensureGlobalDefaults, resolveConfig } from '../src/main/config/loader';
import { DEFAULTS_DIR, tmpDir } from './helpers';

const assistant = (id: string, u: Record<string, number>, content: unknown[] = []) => ({
  type: 'assistant',
  message: { id, content, usage: u },
});

describe('StreamTracker', () => {
  it('dedupes usage per message id until the final result overrides it', () => {
    const t = new StreamTracker();
    t.feed(assistant('m1', { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 5 }));
    t.feed(assistant('m1', { input_tokens: 10, output_tokens: 7, cache_creation_input_tokens: 100, cache_read_input_tokens: 5 }));
    t.feed(assistant('m2', { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 }));
    expect(t.summary.usage).toEqual({ input: 13, output: 9, cacheCreation: 100, cacheRead: 55, costUsd: 0 });
    expect(billableTokens(t.summary.usage)).toBe(122);
    t.feed({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      total_cost_usd: 0.01,
      usage: { input_tokens: 20, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 55 },
    });
    expect(t.summary.usage.input).toBe(20);
    expect(t.summary.usage.costUsd).toBe(0.01);
    expect(t.summary.result).toEqual({ isError: false, subtype: 'success', text: 'ok' });
    expect(t.summary.rateLimited).toBe(false);
  });

  it('detects rejected rate limits with reset time', () => {
    const t = new StreamTracker();
    t.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1 } });
    expect(t.summary.rateLimited).toBe(false);
    t.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793314800 } });
    expect(t.summary.rateLimited).toBe(true);
    expect(t.summary.rateLimitResetsAt).toBe(1793314800000);
  });

  it('treats an error result mentioning usage limit as rate limited', () => {
    const t = new StreamTracker();
    t.feed({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1793314800' });
    expect(t.summary.result?.isError).toBe(true);
    expect(t.summary.rateLimited).toBe(true);
  });
});

describe('LineSplitter', () => {
  it('reassembles lines across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n\n{"c":3}')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual(['{"c":3}']);
  });
});

describe('formatEvent', () => {
  it('renders text, tool calls and results for the stream view', () => {
    const out = formatEvent(assistant('m', {}, [{ type: 'text', text: 'hi\nthere' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a' } }]));
    expect(out).toContain('hi\r\nthere\r\n');
    expect(out).toContain('→ Read {"file_path":"a"}');
    expect(formatEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBe('');
    expect(formatEvent({ type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0.5 })).toContain('$0.5000');
  });
});

describe('claude command', () => {
  const g = tmpDir();
  ensureGlobalDefaults(DEFAULTS_DIR, g);

  it('background: stream-json, session id, mcp config, role model/effort/permissions, configured extra args', () => {
    const cfg = resolveConfig({ globalDir: g }, { role: 'task' });
    const c = backgroundCommand(cfg, { sessionId: 'sid', mcpConfigPath: '/m.json' });
    expect(c.binary).toBe('claude');
    const a = c.args;
    expect(a.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(a[a.indexOf('--session-id') + 1]).toBe('sid');
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('/m.json');
    expect(a[a.indexOf('--model') + 1]).toBe('haiku');
    expect(a[a.indexOf('--effort') + 1]).toBe('low');
    expect(a[a.indexOf('--allowedTools') + 1]).toContain('mcp__aiegis');
    expect(a[a.indexOf('--disallowedTools') + 1]).toContain('Edit');
    expect(a[a.indexOf('--append-system-prompt') + 1]).toContain('submit_result');
    expect(a).toContain('--strict-mcp-config');
    expect(a).not.toContain('--add-dir');
  });

  it('extra directories of a role become --add-dir, ~/ expanded', () => {
    const a = backgroundCommand(resolveConfig({ globalDir: g }, { role: 'sca-inventory' }), { sessionId: 's', mcpConfigPath: '/m' }).args;
    expect(a[a.indexOf('--add-dir') + 1]).toBe(path.join(os.homedir(), '.gradle/caches'));
  });

  it('interactive: resume vs new session', () => {
    const cfg = resolveConfig({ globalDir: g }, { role: 'assistant' });
    expect(interactiveCommand(cfg, { sessionId: 's', resume: true, mcpConfigPath: '/m' }).args.slice(0, 2)).toEqual(['--resume', 's']);
    const n = interactiveCommand(cfg, { sessionId: 's', resume: false, mcpConfigPath: '/m' }).args;
    expect(n.slice(0, 2)).toEqual(['--session-id', 's']);
    expect(n).not.toContain('-p');
  });

  it('shellQuote', () => {
    expect(shellQuote('/a/b-c.json')).toBe('/a/b-c.json');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe(`''`);
  });
});
