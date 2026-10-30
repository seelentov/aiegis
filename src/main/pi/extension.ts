// pi extension loaded into every pi session aiegis starts (`--extension`); bundled to dist/pi-extension.mjs.
// Connects the run's aiegis MCP server and enforces the role's permissions, which pi itself does not have.
// In tester sessions it also confines bash to the OS sandbox and asks the app's hook about every command.
import fs from 'node:fs';
import { decide, type PiRunConfig } from './permissions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tester = NonNullable<PiRunConfig['tester']>;

/** The app's PreToolUse hook (the same one Claude Code tester sessions call): a deny reason or null. Fails closed. */
async function askHook(t: Tester, token: string, toolInput: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(t.hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `the aiegis hook answered ${res.status}`;
    const out = (await res.json()) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return out.hookSpecificOutput?.permissionDecision === 'deny' ? (out.hookSpecificOutput.permissionDecisionReason ?? 'denied') : null;
  } catch (e) {
    return `the aiegis hook is unreachable: ${(e as Error).message}`;
  }
}

/** Starts the sandbox runtime (network proxy with the allowlist); writes are allowed in the working directory. */
async function startSandbox(t: Tester, cwd: string): Promise<any> {
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  if (!SandboxManager.isSupportedPlatform()) throw new Error(`no OS sandbox on ${process.platform}`);
  const cfg = structuredClone(t.sandbox) as any;
  cfg.network = { allowedDomains: [], deniedDomains: [], ...cfg.network };
  cfg.filesystem = { denyRead: [], denyWrite: [], ...cfg.filesystem, allowWrite: [...(cfg.filesystem?.allowWrite ?? []), cwd] };
  await SandboxManager.initialize(cfg);
  return SandboxManager;
}

export default function aiegis(pi: any): void {
  const file = process.env.AIEGIS_PI_RUN;
  if (!file) throw new Error('aiegis: AIEGIS_PI_RUN is not set');
  const rc = JSON.parse(fs.readFileSync(file, 'utf8')) as PiRunConfig;
  pi.registerMcpServer('aiegis', {
    url: rc.mcp.url,
    headers: { Authorization: `Bearer ${rc.mcp.token}` },
    exposure: 'direct',
    description: 'aiegis: audit data of this project (read and write within the run scope)',
  });

  const tester = rc.tester;
  let sandbox: Promise<any> | null = null;
  if (tester) {
    pi.on('session_start', (_e: any, ctx: any) => {
      sandbox = startSandbox(tester, ctx.cwd ?? process.cwd());
      sandbox.catch(() => undefined);
    });
    pi.on('session_shutdown', async () => {
      await (await sandbox?.catch(() => null))?.reset?.();
    });
  }

  pi.on('tool_call', async (event: any, ctx: any) => {
    const input = event.input ?? {};
    const d = decide(rc, ctx.cwd ?? process.cwd(), event.toolName, input);
    if (d.kind === 'deny' || (d.kind === 'ask' && !(ctx.hasUI && (await ctx.ui.confirm('Allow tool call?', `${event.toolName}: ${d.reason}`))))) {
      return { block: true, reason: d.reason };
    }
    if (!tester || event.toolName !== 'bash') return undefined;
    const reason = await askHook(tester, rc.mcp.token, input);
    if (reason) return { block: true, reason };
    let manager: any;
    try {
      if (!sandbox) throw new Error('the session has not started');
      manager = await sandbox;
    } catch (e) {
      return { block: true, reason: `tester commands run only in the OS sandbox, which is unavailable: ${(e as Error).message}` };
    }
    // The runtime exempts localhost from its proxy (NO_PROXY) and the OS profile forbids direct connections, so a local
    // instance is reachable only through the proxy, whose allowlist names exactly the base URL's host:port.
    input.command = await manager.wrapWithSandbox(`unset NO_PROXY no_proxy; ${String(input.command ?? '')}`);
    return undefined;
  });
}
