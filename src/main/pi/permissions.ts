import os from 'node:os';
import path from 'node:path';

/** Per-run file the aiegis pi extension reads (`AIEGIS_PI_RUN`): the MCP server and the role's permissions. */
export interface PiRunConfig {
  mcp: { url: string; token: string };
  /** Permission rules in Claude Code syntax (`Read`, `Bash(git log:*)`, `Write(./.aiegis-sca/**)`, `mcp__aiegis`). */
  allow: string[];
  deny: string[];
  /** Absolute directories outside the working directory the agent may access. */
  dirs: string[];
  /** Claude Code tool name -> pi tool names (`pi.tools`). */
  tools: Record<string, string[]>;
  /** PoC tester only: bash runs in the OS sandbox and every command is checked by the app's hook first. */
  tester?: { sandbox: Record<string, unknown>; hookUrl: string };
}

export type Decision = { kind: 'allow' } | { kind: 'deny' | 'ask'; reason: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Input = Record<string, any>;

const PATH_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'LS'];

export function parseRule(rule: string): { name: string; spec?: string } {
  const m = /^([^()]+)\((.*)\)$/.exec(rule.trim());
  return m ? { name: m[1], spec: m[2] } : { name: rule.trim() };
}

function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Absolute path a path tool works on (default: the working directory). */
function targetPath(input: Input, cwd: string): string {
  const raw = String(input.path ?? input.file_path ?? '.').replace(/^@/, '');
  return path.resolve(cwd, expandHome(raw));
}

/** `./x` and `x` are relative to the working directory, `~/x` to home, `//x` is absolute. */
function pathSpecMatches(spec: string, file: string, cwd: string): boolean {
  const abs = spec.startsWith('//') ? spec.slice(1) : spec.startsWith('~') ? expandHome(spec) : path.join(cwd, spec);
  const re = globRegExp(abs);
  // `dir/**` also covers the directory itself.
  return re.test(file) || (abs.endsWith('/**') && file === abs.slice(0, -3));
}

/** `git log:*` = the command or the command followed by arguments; otherwise exact, `*` as a wildcard. */
function commandMatches(spec: string, command: string): boolean {
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2);
    return command === prefix || (command.startsWith(prefix) && /\s/.test(command[prefix.length]));
  }
  return spec.includes('*') ? new RegExp(`^${spec.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*')}$`, 's').test(command) : spec === command;
}

/**
 * Simple commands of a Bash line, split at `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. `unsafe` = the line
 * can hide another command or a file write: a substitution outside single quotes or a redirect outside quotes.
 */
export function parseCommand(command: string): { parts: string[]; unsafe: boolean } {
  const parts: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let unsafe = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') {
      cur += c + (command[i + 1] ?? '');
      i++;
      continue;
    } else if (c === '`' || (c === '$' && command[i + 1] === '(')) {
      unsafe = true;
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '<' || c === '>') {
      unsafe = true;
    } else if (';|&\n'.includes(c)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return { parts, unsafe };
}

function ruleMatches(rule: string, claudeName: string, input: Input, cwd: string, command?: string): boolean {
  const { name, spec } = parseRule(rule);
  if (claudeName.startsWith('mcp__')) return claudeName === name || claudeName.startsWith(`${name}__`) || (name.includes('*') && globRegExp(name).test(claudeName));
  if (name !== claudeName) return false;
  if (spec === undefined || spec === '*' || spec === '') return true;
  if (claudeName === 'Bash') return commandMatches(spec, command ?? String(input.command ?? ''));
  if (PATH_TOOLS.includes(claudeName)) return pathSpecMatches(spec, targetPath(input, cwd), cwd);
  return false;
}

const inside = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * Decides a pi tool call by the role's Claude Code-style rules: deny wins; then allow; else "ask" (interactive sessions
 * confirm, background runs block). Path tools stay inside the working directory and `dirs` unless a rule names the path.
 */
export function decide(rc: PiRunConfig, cwd: string, toolName: string, input: Input): Decision {
  const names = toolName.startsWith('mcp__') ? [toolName] : Object.keys(rc.tools).filter((k) => rc.tools[k].includes(toolName));
  if (!names.length) return { kind: 'ask', reason: `tool ${toolName} is not covered by the role's permissions` };
  const isBash = names.includes('Bash');
  const { parts, unsafe } = isBash ? parseCommand(String(input.command ?? '')) : { parts: [], unsafe: false };
  const any = (rules: string[], command?: string) => rules.some((r) => names.some((n) => ruleMatches(r, n, input, cwd, command)));

  if (any(rc.deny) || (isBash && parts.some((p) => any(rc.deny, p)))) return { kind: 'deny', reason: `${toolName} is denied for this role` };

  const bare = rc.allow.some((r) => {
    const { name, spec } = parseRule(r);
    return spec === undefined && names.includes(name);
  });
  if (isBash && !bare) {
    // Pattern rules allow one simple command per call, like Claude Code checks each part of a compound command.
    if (unsafe) return { kind: 'ask', reason: 'run one simple command per call, without redirects or substitutions' };
    if (parts.length && parts.every((p) => any(rc.allow, p))) return { kind: 'allow' };
    return { kind: 'ask', reason: `command is not in the role's allowlist: ${String(input.command ?? '')}` };
  }
  if (!any(rc.allow)) return { kind: 'ask', reason: `${toolName} is not allowed for this role` };

  const pathTool = names.some((n) => PATH_TOOLS.includes(n));
  if (pathTool && bare) {
    const file = targetPath(input, cwd);
    if (![cwd, ...rc.dirs].some((d) => inside(file, path.resolve(d)))) return { kind: 'ask', reason: `${file} is outside the working directories` };
  }
  return { kind: 'allow' };
}
