import os from 'node:os';
import path from 'node:path';
import { effectiveAllow, joinInstructions } from '../config/cascade';
import type { EffectiveConfig } from '../config/loader';

export interface ClaudeCommand {
  binary: string;
  args: string[];
  env: Record<string, string>;
  /** Variables of the app's environment the process inherits; all when unset. */
  inherit?: string[];
}

/** Directories outside the working directory: the role's `permissions.dirs` (`~/` = home) plus `extra`. */
export function dirsOf(cfg: EffectiveConfig, extra: string[] = []): string[] {
  return [...cfg.level.permissions.dirs.map((d) => (d.value.startsWith('~/') ? path.join(os.homedir(), d.value.slice(2)) : d.value)), ...extra];
}

function levelArgs(cfg: EffectiveConfig, dirs: string[] = []): string[] {
  const args: string[] = [];
  const { level } = cfg;
  if (level.model) args.push('--model', level.model.value);
  if (level.effort) args.push('--effort', level.effort.value);
  const instructions = joinInstructions(level);
  if (instructions) args.push('--append-system-prompt', instructions);
  const allow = effectiveAllow(level);
  if (allow.length) args.push('--allowedTools', allow.join(','));
  const deny = level.permissions.deny.map((d) => d.value);
  if (deny.length) args.push('--disallowedTools', deny.join(','));
  for (const d of dirsOf(cfg, dirs)) args.push('--add-dir', d);
  return args;
}

export function envOf(cfg: EffectiveConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(cfg.level.env).map(([k, v]) => [k, v.value]));
}

/** Non-interactive run; the prompt is written to stdin. */
export function backgroundCommand(cfg: EffectiveConfig, o: { sessionId: string; mcpConfigPath: string; dirs?: string[] }): ClaudeCommand {
  return {
    binary: cfg.settings.claude.binary,
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      o.sessionId,
      '--mcp-config',
      o.mcpConfigPath,
      ...levelArgs(cfg, o.dirs),
      ...cfg.settings.claude.background_args,
    ],
    env: envOf(cfg),
  };
}

/** Interactive session: new (`--session-id`) or continued (`--resume`), optionally with an initial prompt. */
export function interactiveCommand(
  cfg: EffectiveConfig,
  o: { sessionId: string; resume: boolean; mcpConfigPath: string; prompt?: string; dirs?: string[] },
): ClaudeCommand {
  return {
    binary: cfg.settings.claude.binary,
    args: [
      // The initial prompt goes first: later options (--allowedTools) are variadic.
      ...(o.prompt ? [o.prompt] : []),
      o.resume ? '--resume' : '--session-id',
      o.sessionId,
      '--mcp-config',
      o.mcpConfigPath,
      ...levelArgs(cfg, o.dirs),
      ...cfg.settings.claude.interactive_args,
    ],
    env: envOf(cfg),
  };
}

/** POSIX shell quoting for "open in external terminal". */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
