// Types shared between main and renderer.

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'taken_over';

export interface Job {
  id: string;
  projectId: string;
  type: string;
  role: string;
  title: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  error: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunKind = 'background' | 'interactive';

export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rate_limited'
  | 'token_limit'
  | 'taken_over'
  | 'exited'
  | 'interrupted';

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  costUsd: number;
}

export interface Run {
  id: string;
  projectId: string;
  jobId: string | null;
  parentRunId: string | null;
  kind: RunKind;
  role: string;
  author: string;
  entityType: string | null;
  entityId: string | null;
  sessionId: string;
  cwd: string;
  commitSha: string;
  configSnapshot: unknown;
  logPath: string | null;
  status: RunStatus;
  error: string | null;
  usage: TokenUsage;
  startedAt: string;
  finishedAt: string | null;
}

export interface ResultRecord {
  id: string;
  runId: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
  author: string;
  createdAt: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
}

export interface QueueState {
  pausedUntil: number | null;
  parallelism: number;
  running: number;
}

export interface TerminalInfo {
  id: string;
  title: string;
  /** "stream" = read-only view of a background run; "pty" = interactive claude. */
  mode: 'stream' | 'pty';
  projectId: string;
  runId: string;
  alive: boolean;
}

export interface ConfigFileInfo {
  scope: 'global' | 'project';
  path: string;
  /** Path relative to the scope's config directory. */
  rel: string;
  exists: boolean;
}

export interface EffectiveConfigView {
  role: { name: string; title: string; kind: string; mcp_access: string };
  model?: { value: string; source: string };
  effort?: { value: string; source: string };
  instructions: { source: string; file?: string; text: string }[];
  allow: { value: string; source: string; denied: boolean }[];
  deny: { value: string; source: string }[];
  env: { key: string; value: string; source: string }[];
  settings: { key: string; value: string; source: string }[];
}

export type AppEvent =
  | { type: 'jobs-changed'; projectId: string }
  | { type: 'runs-changed'; projectId: string }
  | { type: 'queue-changed'; state: QueueState }
  | { type: 'terminals-changed' }
  | { type: 'terminal-data'; terminalId: string; data: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; projectId?: string };
