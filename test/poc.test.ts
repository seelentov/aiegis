import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountsText, allowedHost, pickEnv, hookDecision, PocInstance, pocEnvironment, resolveSecrets, secretEnvName, testerSettings } from '../src/main/poc';
import { tmpDir } from './helpers';

const base = { start_timeout_sec: 5, healthcheck_interval_sec: 1, stop_timeout_sec: 5, env_passthrough: [], claude_settings: {} };
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command, ...extra } });

describe('poc environment', () => {
  it('is unavailable without environment or with missing fields', () => {
    expect(pocEnvironment(base)).toEqual({ reason: expect.stringContaining('poc.environment') });
    expect(pocEnvironment({ ...base, environment: { start: 'x', base_url: 'http://a' } })).toEqual({ reason: 'poc.environment is missing: healthcheck' });
    expect(pocEnvironment({ ...base, environment: { start: 'x', healthcheck: 'y', base_url: 'ftp://a' } })).toEqual({ reason: expect.stringContaining('http') });
    expect(pocEnvironment({ ...base, environment: { start: 'x', healthcheck: 'y', stop: ' ', base_url: 'http://127.0.0.1:8080' } })).toEqual({
      env: { start: 'x', healthcheck: 'y', stop: null, base_url: 'http://127.0.0.1:8080', accounts: {} },
    });
  });

  it('secrets come from env variables; missing ones are an error; the prompt names variables only', async () => {
    const accounts = { 'alice@a': { username: 'alice', tenant: 'a', secrets: { password: { env: 'X_PW' } } } };
    expect(secretEnvName('alice@a', 'password')).toBe('AIEGIS_POC_ALICE_A_PASSWORD');
    await expect(resolveSecrets(accounts, { X_PW: 's3cret' })).resolves.toEqual({ AIEGIS_POC_ALICE_A_PASSWORD: 's3cret' });
    await expect(resolveSecrets(accounts, {})).rejects.toThrow('X_PW');
    const text = accountsText(accounts);
    expect(text).toContain('$AIEGIS_POC_ALICE_A_PASSWORD');
    expect(text).not.toContain('X_PW');
    expect(pickEnv(['PATH', 'NOPE'], { PATH: '/bin', TOKEN: 't' })).toEqual({ PATH: '/bin' });
  });
});

describe('tester sandbox and hook', () => {
  it('adds the base URL host to the sandbox allowlist and the app hook after configured hooks', () => {
    const cfg = { sandbox: { enabled: true, network: { allowedDomains: ['idp.test'] } }, hooks: { PreToolUse: [{ matcher: 'Read' }] } };
    const out = testerSettings(cfg, 'http://localhost:8080/api', { url: 'http://127.0.0.1:1/hooks/pre-tool-use', headerFile: '/d/h' }) as any;
    expect(out.sandbox).toMatchObject({ enabled: true, network: { allowedDomains: ['idp.test', 'localhost:8080'] } });
    expect(out.hooks.PreToolUse).toHaveLength(2);
    const hook = out.hooks.PreToolUse[1].hooks[0];
    expect(hook).toMatchObject({ type: 'command', command: 'curl', onFailure: 'block' });
    expect(hook.args).toEqual(expect.arrayContaining(['--noproxy', '@/d/h', 'http://127.0.0.1:1/hooks/pre-tool-use']));
    expect(cfg.sandbox.network.allowedDomains).toEqual(['idp.test']);
    expect(allowedHost('https://app.test')).toBe('app.test:443');
  });

  it('denies requests to other origins, proxies and unsandboxed commands', () => {
    const b = 'http://127.0.0.1:8080';
    expect(hookDecision(b, bash('curl -s http://127.0.0.1:8080/orders/2 -H "X: 1"'))).toBeNull();
    expect(hookDecision(b, bash('python3 .aiegis-poc/x/poc.py'))).toBeNull();
    expect(hookDecision(b, { tool_name: 'Read', tool_input: { file_path: 'http://evil' } })).toBeNull();
    expect(hookDecision(b, bash('curl http://127.0.0.1:9090/'))).toContain('forbidden');
    expect(hookDecision(b, bash("curl 'https://evil.test/?q=1'"))).toContain('evil.test');
    expect(hookDecision(b, bash('curl -x http://127.0.0.1:8080 http://127.0.0.1:8080/'))).toContain('-x');
    expect(hookDecision(b, bash('curl --proxy=h:1 http://127.0.0.1:8080/'))).toContain('--proxy');
    expect(hookDecision(b, bash('ls', { dangerouslyDisableSandbox: true }))).toContain('sandbox');
    expect(hookDecision(b, { tool_name: 'WebFetch', tool_input: { url: 'https://evil.test' } })).toContain('evil.test');
  });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const opts = (cwd: string) => ({ cwd, env: process.env as Record<string, string>, startTimeoutSec: 3, healthcheckIntervalSec: 1, stopTimeoutSec: 3, log: () => undefined });

describe('test instance', () => {
  it('starts, waits for the healthcheck, runs stop and kills the start process group', async () => {
    const dir = tmpDir();
    const port = await freePort();
    const server = `require('http').createServer((q, r) => r.end('ok')).listen(${port})`;
    const env = { start: `node -e "${server}"`, healthcheck: `curl -sf http://127.0.0.1:${port}/`, stop: 'touch stopped', base_url: `http://127.0.0.1:${port}`, accounts: {} };
    const inst = new PocInstance(env, opts(dir));
    await inst.start(new AbortController().signal);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    await inst.stop();
    expect(fs.existsSync(path.join(dir, 'stopped'))).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('fails when start exits with an error or the healthcheck never passes', async () => {
    const dir = tmpDir();
    const env = { start: 'exit 3', healthcheck: 'false', stop: null, base_url: 'http://127.0.0.1:1', accounts: {} };
    await expect(new PocInstance(env, opts(dir)).start(new AbortController().signal)).rejects.toThrow('code 3');
    const slow = new PocInstance({ ...env, start: 'sleep 30' }, { ...opts(dir), startTimeoutSec: 1 });
    await expect(slow.start(new AbortController().signal)).rejects.toThrow('healthcheck');
    await slow.stop();
  });
});
