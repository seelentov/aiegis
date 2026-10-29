import os from 'node:os';
import path from 'node:path';
import { effectiveAllow, joinInstructions } from '../config/cascade';
import type { EffectiveConfig } from '../config/loader';

export interface ClaudeCommand {
  binary: string;
  args: string[];
  env: Record<string, string>;
}

function levelArgs(cfg: EffectiveConfig): string[] {
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
  for (const d of level.permissions.dirs) args.push('--add-dir', d.value.startsWith('~/') ? path.join(os.homedir(), d.value.slice(2)) : d.value);
  return args;
}

function envOf(cfg: EffectiveConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(cfg.level.env).map(([k, v]) => [k, v.value]));
}

/** Non-interactive run; the prompt is written to stdin. */
export function backgroundCommand(cfg: EffectiveConfig, o: { sessionId: string; mcpConfigPath: string }): ClaudeCommand {
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
      ...levelArgs(cfg),
      ...cfg.settings.claude.background_args,
    ],
    env: envOf(cfg),
  };
}

/** Interactive session: new (`--session-id`) or continued (`--resume`), optionally with an initial prompt. */
export function interactiveCommand(
  cfg: EffectiveConfig,
  o: { sessionId: string; resume: boolean; mcpConfigPath: string; prompt?: string },
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
      ...levelArgs(cfg),
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
