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
  /** Entities the run's token may write. */
  scope: { type: string; id: string }[];
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
  /** Code the latest snapshot depends on changed since its commit (SPEC §5). */
  snapshotStale: boolean;
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

export type DocFormat = 'md' | 'pdf' | 'docx';

/** extracting -> review -> approved; failed if the extraction run did not succeed; discarded by the user. */
export type DocVersionStatus = 'extracting' | 'review' | 'approved' | 'failed' | 'discarded';

export interface DocVersion {
  id: string;
  documentId: string;
  /** 1-based number within the document. */
  n: number;
  filename: string;
  format: DocFormat;
  sha256: string;
  status: DocVersionStatus;
  itemCount: number;
  pendingCount: number;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  versions: DocVersion[];
  /** Latest approved version: the requirements matrices use. */
  current: DocVersion | null;
}

export type ReviewState = 'pending' | 'accepted' | 'rejected';

export interface RequirementItem {
  id: string;
  versionId: string;
  /** Stable identity of the requirement across versions (document + key). */
  requirementId: string;
  /** Id from the document, or generated. */
  key: string;
  text: string;
  section: string;
  quote: string;
  review: ReviewState;
  author: string;
  runId: string | null;
  updatedAt: string;
}

export type ItemChange = 'added' | 'changed' | 'same';

export interface DocVersionView {
  document: { id: string; title: string };
  version: DocVersion;
  /** Version the changes are computed against (previous approved one). */
  baseline: DocVersion | null;
  items: (RequirementItem & { change: ItemChange })[];
  removed: RequirementItem[];
  /** Background job of the extraction, if any. */
  job: { id: string; status: JobStatus; lastRunId: string | null; error: string | null } | null;
  /** Imported file as stored by the app. */
  sourceFile: string | null;
  /** Quotes are checked against the extracted text (MD, DOCX); PDF is read by claude directly. */
  quotesVerified: boolean;
}

export interface Matrix {
  id: string;
  name: string;
  documentIds: string[];
  /** Empty = all current modules. */
  moduleIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const VERDICT_STATUSES = ['n/a', 'pass', 'finding', 'needs_human'] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];
export type CellStatus = 'not_checked' | VerdictStatus;

export interface Evidence {
  file: string;
  line?: number;
  note?: string;
}

/** One verdict on a cell (requirement x module); append-only, the latest one is the cell status. */
export interface Verdict {
  id: string;
  moduleId: string;
  requirementId: string;
  /** Requirement item (version) the verdict was given for. */
  itemId: string;
  reqHash: string;
  status: VerdictStatus;
  reason: string;
  evidence: Evidence[];
  commitSha: string;
  touchedFiles: string[];
  moduleGlobs: string[];
  runId: string | null;
  author: string;
  createdAt: string;
}

export interface TriageMark {
  id: string;
  moduleId: string;
  requirementId: string;
  reqHash: string;
  applicable: boolean;
  reason: string;
  runId: string | null;
  createdAt: string;
}

export type StaleReason = 'code' | 'requirement';

export interface Cell {
  moduleId: string;
  requirementId: string;
  status: CellStatus;
  stale: boolean;
  staleReasons: StaleReason[];
  /** Triage said the requirement applies (no verdict yet). */
  triaged: boolean;
  verdict: Verdict | null;
  findingCount: number;
  /** Queued or running job that covers this cell. */
  activeJob: { id: string; status: JobStatus } | null;
}

export interface MatrixView {
  matrix: Matrix;
  head: string;
  modules: Module[];
  requirements: (RequirementItem & { documentTitle: string })[];
  cells: Cell[];
}

export type MatrixStage = 'triage' | 'verdicts';
/** Which cells a run covers: never checked (not_checked) or stale ones. */
export type MatrixScope = 'pending' | 'stale';

export interface MatrixEstimate {
  stage: MatrixStage;
  role: string;
  sessions: number;
  cells: number;
  /** Billable tokens per cell used for the estimate and where it came from. */
  tokensPerCell: number;
  tokensPerCellSource: 'history' | 'config';
  tokens: number;
  maxTokensPerRun: number;
  batches: { moduleId: string; moduleName: string; group: string; cells: number; tokens: number }[];
  /** Cells skipped because a queued or running job already covers them. */
  busy: number;
}

export const FINDING_STATUSES = ['suspected', 'verified', 'false_positive', 'accepted_risk', 'fixed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface FindingInput {
  title: string;
  description: string;
  severity: Severity;
  cwe: string | null;
  moduleId: string | null;
  /** Entry point key ("kind METHOD name"), if the finding is reachable through one. */
  entryPoint: string | null;
  files: Evidence[];
  recommendation: string | null;
}

export interface Finding extends FindingInput {
  id: string;
  status: FindingStatus;
  /** Set when merged into another finding. */
  mergedInto: string | null;
  cells: { moduleId: string; requirementId: string }[];
  runId: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface FindingEvent {
  id: string;
  findingId: string;
  kind: 'created' | 'status' | 'merged' | 'link';
  status: FindingStatus | null;
  reason: string | null;
  mergedInto: string | null;
  cell: { moduleId: string; requirementId: string } | null;
  runId: string | null;
  author: string;
  createdAt: string;
}

export interface SimilarFinding {
  finding: Finding;
  score: number;
  reasons: string[];
}

export interface CellLabel {
  moduleId: string;
  moduleName: string | null;
  requirementId: string;
  key: string | null;
  text: string | null;
}

export interface FindingDetails {
  finding: Finding;
  events: FindingEvent[];
  cells: CellLabel[];
  similar: SimilarFinding[];
  /** Matrix cells and fix sessions that ran for this finding. */
  runs: Run[];
}

export interface CellDetails {
  cell: Cell;
  module: Module | null;
  requirement: (RequirementItem & { documentTitle: string }) | null;
  /** Newest first. */
  verdicts: (Verdict & { run: Run | null })[];
  triage: TriageMark[];
  findings: Finding[];
  /** Events of the linked findings that concern this cell (created, status, link to this cell). */
  findingEvents: FindingEvent[];
  /** Files changed since the verdict's commit that made it stale. */
  changedFiles: string[];
  /** Effective config a re-check of this cell would run with. */
  config: EffectiveConfigView | null;
}

/** Recheck offered after a session in the working directory committed (SPEC §1, Q22). */
export interface RecheckOffer {
  cells: string[];
  /** Why these cells: affected by the commit and/or linked to the fixed finding. */
  reason: string;
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
  | { type: 'audit-changed'; projectId: string }
  | { type: 'queue-changed'; state: QueueState }
  | { type: 'terminals-changed' }
  | { type: 'terminal-data'; terminalId: string; data: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; projectId?: string; recheck?: RecheckOffer };
