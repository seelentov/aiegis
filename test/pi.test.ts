import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { agentOf, ensureGlobalDefaults, resolveConfig } from '../src/main/config/loader';
import { piBackgroundCommand, piInteractiveCommand, piRunConfig, piTools } from '../src/main/pi/args';
import { decide, parseCommand, type PiRunConfig } from '../src/main/pi/permissions';
import { formatPiEvent, PiStreamTracker } from '../src/main/pi/stream';
import { DEFAULTS_DIR, tmpDir } from './helpers';

const TOOLS = { Read: ['read'], Grep: ['grep'], Glob: ['find', 'ls'], Bash: ['bash'], Edit: ['edit'], Write: ['write'] };
const rc = (allow: string[], deny: string[] = [], dirs: string[] = []): PiRunConfig => ({ mcp: { url: 'u', token: 't' }, allow, deny, dirs, tools: TOOLS });
const CWD = '/w/tree';

describe('pi permissions', () => {
  const sca = rc(['Read', 'Glob', 'mcp__aiegis', 'Write(./.aiegis-sca/**)', 'Bash(git log:*)', 'Bash(npm ls:*)'], ['WebFetch'], ['/home/u/.m2']);

  it('allows tools and MCP tools the rules name', () => {
    expect(decide(sca, CWD, 'read', { path: 'src/a.ts' }).kind).toBe('allow');
    expect(decide(sca, CWD, 'ls', {}).kind).toBe('allow');
    expect(decide(sca, CWD, 'mcp__aiegis__whoami', {}).kind).toBe('allow');
    expect(decide(sca, CWD, 'mcp__other__x', {}).kind).toBe('ask');
    expect(decide(sca, CWD, 'grep', { pattern: 'x' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'codemode', { code: '' }).kind).toBe('ask');
  });

  it('keeps path tools inside the working directory and dirs', () => {
    expect(decide(sca, CWD, 'read', { path: '/home/u/.m2/a.jar' }).kind).toBe('allow');
    expect(decide(sca, CWD, 'read', { path: '../other/secret' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'read', { path: '/etc/passwd' }).kind).toBe('ask');
  });

  it('path rules: writes only into the run directory', () => {
    expect(decide(sca, CWD, 'write', { path: '.aiegis-sca/j1/init.gradle', content: '' }).kind).toBe('allow');
    expect(decide(sca, CWD, 'write', { path: `${CWD}/.aiegis-sca/x` }).kind).toBe('allow');
    expect(decide(sca, CWD, 'write', { path: 'build.gradle', content: '' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'write', { path: '.aiegis-sca/../build.gradle' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'edit', { path: '.aiegis-sca/x' }).kind).toBe('ask');
  });

  it('bash pattern rules: prefix with a word boundary, one simple command per call', () => {
    expect(decide(sca, CWD, 'bash', { command: 'git log -5' }).kind).toBe('allow');
    expect(decide(sca, CWD, 'bash', { command: 'git log' }).kind).toBe('allow');
    expect(decide(sca, CWD, 'bash', { command: 'git logx' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'bash', { command: 'git log && npm ls' }).kind).toBe('allow');
    expect(decide(sca, CWD, 'bash', { command: 'git log; rm -rf /' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'bash', { command: 'git log $(rm -rf /)' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'bash', { command: 'git log > /tmp/x' }).kind).toBe('ask');
    expect(decide(sca, CWD, 'bash', { command: 'git log | sh' }).kind).toBe('ask');
  });

  it('deny wins, also for one part of a compound command', () => {
    const r = rc(['Bash'], ['Bash(rm:*)', 'Write']);
    expect(decide(r, CWD, 'bash', { command: 'ls; rm -rf x' }).kind).toBe('deny');
    expect(decide(r, CWD, 'bash', { command: 'ls > a && echo $(id)' }).kind).toBe('allow');
    expect(decide(r, CWD, 'write', { path: 'a' }).kind).toBe('deny');
    expect(decide(rc(['mcp__aiegis'], ['mcp__aiegis__cancel_job']), CWD, 'mcp__aiegis__cancel_job', {}).kind).toBe('deny');
  });

  it('splits commands at shell operators outside quotes; flags substitutions and redirects', () => {
    expect(parseCommand('a && b || c; d | e & f\ng')).toEqual({ parts: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], unsafe: false });
    expect(parseCommand(`python3 -c "import x; print(1 > 0)" && echo 'a|b'`)).toEqual({ parts: [`python3 -c "import x; print(1 > 0)"`, `echo 'a|b'`], unsafe: false });
    expect(parseCommand(`echo a\\;b`).parts).toEqual([`echo a\\;b`]);
    expect(parseCommand(`echo "$(id)"`).unsafe).toBe(true);
    expect(parseCommand(`echo '$(id)'`).unsafe).toBe(false);
    expect(parseCommand('echo `id`').unsafe).toBe(true);
    expect(parseCommand('echo x > f').unsafe).toBe(true);
    expect(parseCommand(`echo "unterminated; rm -rf /`).parts).toHaveLength(1);
  });

  it('a quoted separator does not split the command', () => {
    const r = rc(['Bash(python3:*)']);
    expect(decide(r, CWD, 'bash', { command: `python3 -c "import a; print(1)"` }).kind).toBe('allow');
    expect(decide(r, CWD, 'bash', { command: `python3 -c "import a"; rm -rf x` }).kind).toBe('ask');
  });
});

describe('pi command', () => {
  const g = tmpDir();
  ensureGlobalDefaults(DEFAULTS_DIR, g);
  const file = path.join(g, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  doc.set('agent', 'pi');
  fs.writeFileSync(file, doc.toString());

  it('agent comes from the cascade; claude by default', () => {
    const d = tmpDir();
    ensureGlobalDefaults(DEFAULTS_DIR, d);
    expect(agentOf(resolveConfig({ globalDir: d }, { role: 'task' }))).toBe('claude');
    expect(agentOf(resolveConfig({ globalDir: g }, { role: 'task' }))).toBe('pi');
  });

  it('background: json mode, session id, extension, model/thinking, declared tools, isolation args', () => {
    const cfg = resolveConfig({ globalDir: g }, { role: 'task' });
    const c = piBackgroundCommand(cfg, { sessionId: 'sid', runFile: '/r.json' });
    const a = c.args;
    expect(c.binary).toBe('pi');
    expect(c.env.AIEGIS_PI_RUN).toBe('/r.json');
    expect(a.slice(0, 4)).toEqual(['--mode', 'json', '--session-id', 'sid']);
    expect(a[a.indexOf('--extension') + 1]).toMatch(/pi-extension\.mjs$/);
    expect(a[a.indexOf('--model') + 1]).toBe('haiku');
    expect(a[a.indexOf('--thinking') + 1]).toBe('low');
    expect(a[a.indexOf('--tools') + 1].split(',').sort()).toEqual(['bash', 'find', 'grep', 'ls', 'mcp__aiegis__*', 'read']);
    expect(a[a.indexOf('--append-system-prompt') + 1]).toContain('submit_result');
    expect(a).toContain('--no-extensions');
    expect(a).toContain('builtin:mcp');
  });

  it('bare deny removes a tool; interactive declares all mapped tools and MCP', () => {
    expect(piTools(resolveConfig({ globalDir: g }, { role: 'requirements' }), false).sort()).toEqual(['find', 'grep', 'ls', 'mcp__aiegis__*', 'read']);
    const cfg = resolveConfig({ globalDir: g }, { role: 'assistant' });
    expect(piTools(cfg, true).sort()).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'mcp__*', 'read', 'write']);
    const a = piInteractiveCommand(cfg, { sessionId: 's', runFile: '/r', prompt: '-fix it' }).args;
    expect(a.slice(0, 2)).toEqual(['--session-id', 's']);
    expect(a.slice(-2)).toEqual(['--', '-fix it']);
    expect(a).not.toContain('--mode');
  });

  it('run file: rules, ~/ dirs expanded, extra dirs, tool map', () => {
    const r = piRunConfig(resolveConfig({ globalDir: g }, { role: 'sca-inventory' }), { url: 'http://x/mcp', token: 'tok' }, ['/repo']);
    expect(r.mcp).toEqual({ url: 'http://x/mcp', token: 'tok' });
    expect(r.allow).toContain('Write(./.aiegis-sca/**)');
    expect(r.deny).toContain('WebFetch');
    expect(r.dirs).toEqual([path.join(os.homedir(), '.gradle/caches'), path.join(os.homedir(), '.m2/repository'), '/repo']);
    expect(r.tools.Glob).toEqual(['find', 'ls']);
  });
});

const assistant = (m: Record<string, unknown>) => ({ type: 'message_end', message: { role: 'assistant', content: [], ...m } });
const usage = (input: number, output: number, cacheWrite: number, cacheRead: number, total: number) => ({ input, output, cacheWrite, cacheRead, cost: { total } });

describe('PiStreamTracker', () => {
  it('sums usage of assistant messages; the last stop reason is the outcome', () => {
    const t = new PiStreamTracker();
    t.feed({ type: 'message_end', message: { role: 'user', content: 'x' } });
    t.feed(assistant({ stopReason: 'toolUse', usage: usage(10, 2, 100, 0, 0.01) }));
    t.feed(assistant({ stopReason: 'stop', usage: usage(5, 3, 0, 100, 0.02), content: [{ type: 'text', text: 'done' }] }));
    expect(t.summary.usage).toEqual({ input: 15, output: 5, cacheCreation: 100, cacheRead: 100, costUsd: 0.03 });
    expect(t.summary.result).toEqual({ isError: false, subtype: 'stop', text: 'done' });
  });

  it('a provider error is a failed run (pi exits 0); rate limits are detected', () => {
    const t = new PiStreamTracker();
    t.feed(assistant({ stopReason: 'error', errorMessage: '400 invalid', usage: usage(0, 0, 0, 0, 0) }));
    expect(t.summary.result).toEqual({ isError: true, subtype: 'error', text: '400 invalid' });
    expect(t.summary.rateLimited).toBe(false);
    t.feed(assistant({ stopReason: 'error', errorMessage: '429 rate limit exceeded' }));
    expect(t.summary.rateLimited).toBe(true);
  });

  it('formats events for the stream view', () => {
    expect(formatPiEvent({ type: 'session', id: 's1', cwd: '/w' })).toContain('session=s1');
    const out = formatPiEvent(assistant({ stopReason: 'toolUse', content: [{ type: 'text', text: 'a\nb' }, { type: 'toolCall', name: 'read', arguments: { path: 'x' } }] }));
    expect(out).toContain('a\r\nb\r\n');
    expect(out).toContain('→ read {"path":"x"}');
    expect(formatPiEvent({ type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false })).toContain('← ok');
    expect(formatPiEvent({ type: 'message_update' })).toBe('');
  });
});
