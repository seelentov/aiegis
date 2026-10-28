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

export interface Module {
  id: string;
  name: string;
  /** Git pathspec globs relative to the repository root; a leading "!" excludes. */
  globs: string[];
  description: string;
  /** Author and run of the latest revision. */
  author: string;
  runId: string | null;
  updatedAt: string;
}

export interface ModuleRevision {
  id: string;
  moduleId: string;
  name: string;
  globs: string[];
  description: string;
  deleted: boolean;
  reason: string | null;
  runId: string | null;
  author: string;
  createdAt: string;
}

export const ENTRY_POINT_KINDS = ['http', 'grpc', 'graphql', 'queue', 'cron', 'cli', 'websocket'] as const;
export type EntryPointKind = (typeof ENTRY_POINT_KINDS)[number];

export interface EntryPointInput {
  kind: EntryPointKind;
  /** HTTP method or similar qualifier, if any. */
  method: string | null;
  /** Route, RPC/topic/job/command name. */
  name: string;
  handler: { file: string; line: number };
  middleware: string[];
  /** Authorization requirements as found in code. */
  auth: string;
  params: { name: string; source: string; type?: string }[];
  /** Call chain from the handler to sinks. */
  callChain: { file: string; function: string; line?: number; sink?: string }[];
  notes: string | null;
}

export interface EntryPoint extends EntryPointInput {
  id: string;
  snapshotId: string;
  /** Identity within a snapshot: kind + method + name. */
  key: string;
  updatedAt: string;
}

export type SnapshotStatus = 'building' | 'complete' | 'failed';

export interface EntryPointSnapshot {
  id: string;
  moduleId: string;
  runId: string;
  commitSha: string;
  globs: string[];
  status: SnapshotStatus;
  /** Handler and call chain files; null while building. */
  touchedFiles: string[] | null;
  entryCount: number;
  createdAt: string;
  finishedAt: string | null;
}

export type EntryPointChange = 'added' | 'changed' | 'same';

export interface ModuleSummary extends Module {
  latestSnapshot: EntryPointSnapshot | null;
  /** Queued or running entry point job of the module. */
  activeJob: { id: string; status: JobStatus } | null;
}

export interface EntryPointMap {
  snapshots: EntryPointSnapshot[];
  snapshot: EntryPointSnapshot | null;
  /** Snapshot the changes are computed against (previous complete one). */
  baseline: EntryPointSnapshot | null;
  entries: (EntryPoint & { change: EntryPointChange })[];
  removed: EntryPoint[];
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
  | { type: 'modules-changed'; projectId: string }
  | { type: 'queue-changed'; state: QueueState }
  | { type: 'terminals-changed' }
  | { type: 'terminal-data'; terminalId: string; data: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; projectId?: string };
