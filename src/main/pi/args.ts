import path from 'node:path';
import { effectiveAllow, joinInstructions } from '../config/cascade';
import type { EffectiveConfig } from '../config/loader';
import { dirsOf, envOf, type ClaudeCommand } from '../claude/args';
import { parseRule, type PiRunConfig } from './permissions';

/** The aiegis pi extension, bundled next to main.js (scripts/build.mjs). */
export const PI_EXTENSION = path.join(__dirname, 'pi-extension.mjs');

/** Contents of the run file the extension reads: MCP server, permission rules, extra directories. */
export function piRunConfig(
  cfg: EffectiveConfig,
  mcp: { url: string; token: string },
  dirs: string[] = [],
  tester?: PiRunConfig['tester'],
): PiRunConfig {
  return {
    mcp,
    allow: effectiveAllow(cfg.level),
    deny: cfg.level.permissions.deny.map((d) => d.value),
    dirs: dirsOf(cfg, dirs),
    tools: cfg.settings.pi.tools,
    ...(tester ? { tester } : {}),
  };
}

/**
 * pi tools declared to the model (`--tools`). Background runs get the tools their allow rules name; interactive
 * sessions get every mapped tool and any MCP tool (the extension asks the user about calls outside the rules).
 * Tools a bare deny rule names are never declared.
 */
export function piTools(cfg: EffectiveConfig, interactive: boolean): string[] {
  const map = cfg.settings.pi.tools;
  const denied = new Set(cfg.level.permissions.deny.map((d) => parseRule(d.value)).filter((r) => r.spec === undefined).flatMap((r) => map[r.name] ?? []));
  const names = interactive ? Object.keys(map) : effectiveAllow(cfg.level).map((a) => parseRule(a).name);
  const tools = new Set(names.flatMap((n) => map[n] ?? []).filter((t) => !denied.has(t)));
  if (interactive) tools.add('mcp__*');
  else for (const n of names) if (n.startsWith('mcp__')) tools.add(n.split('__').length > 2 ? n : `${n}__*`);
  return [...tools];
}

function levelArgs(cfg: EffectiveConfig, interactive: boolean): string[] {
  const args: string[] = [];
  const { level } = cfg;
  if (level.model) args.push('--model', level.model.value);
  if (level.effort) args.push('--thinking', level.effort.value);
  const instructions = joinInstructions(level);
  if (instructions) args.push('--append-system-prompt', instructions);
  args.push('--tools', piTools(cfg, interactive).join(','));
  return args;
}

/** Non-interactive pi run (`--mode json`); the prompt is written to stdin. `runFile` holds the run's PiRunConfig. */
export function piBackgroundCommand(cfg: EffectiveConfig, o: { sessionId: string; runFile: string }): ClaudeCommand {
  return {
    binary: cfg.settings.pi.binary,
    args: ['--mode', 'json', '--session-id', o.sessionId, '--extension', PI_EXTENSION, ...levelArgs(cfg, false), ...cfg.settings.pi.background_args],
    env: { ...envOf(cfg), AIEGIS_PI_RUN: o.runFile },
  };
}

/** Interactive pi session; `--session-id` opens the session or creates it. The initial prompt goes last. */
export function piInteractiveCommand(cfg: EffectiveConfig, o: { sessionId: string; runFile: string; prompt?: string }): ClaudeCommand {
  return {
    binary: cfg.settings.pi.binary,
    args: [
      '--session-id',
      o.sessionId,
      '--extension',
      PI_EXTENSION,
      ...levelArgs(cfg, true),
      ...cfg.settings.pi.interactive_args,
      ...(o.prompt ? ['--', o.prompt] : []),
    ],
    env: { ...envOf(cfg), AIEGIS_PI_RUN: o.runFile },
  };
}
