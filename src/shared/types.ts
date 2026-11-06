// Types shared between main and renderer.

export const LANGUAGES = ['en', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

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

/** `plugin`: a method the host platform/framework calls with user-influenced data (SPI, listeners, hooks), not a route. */
export const ENTRY_POINT_KINDS = ['http', 'grpc', 'graphql', 'queue', 'cron', 'cli', 'websocket', 'plugin'] as const;
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

/** What the document says about itself, as it writes it; empty when it does not say. */
export interface DocInfo {
  name: string;
  number: string;
  date: string;
  edition: string;
}

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
  info: DocInfo;
}

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  versions: DocVersion[];
  /** Latest approved version: the requirements matrices use. */
  current: DocVersion | null;
  /** Plan entry of a document written by AI (SPEC §22); null for uploaded documents. */
  generated: DocPlanEntry | null;
  /** Set it belongs to (SPEC §24). */
  setId: string | null;
  /** Where its edition is checked. */
  source: DocLink | null;
  edition: string | null;
  lastCheck: DocCheck | null;
  /** Out of force: its requirements leave matrices and the refresher skips it; history stays. */
  retiredAt: string | null;
  retiredReason: string | null;
  /** Document this one replaces once approved. */
  replaces: string | null;
}

/** A source link; `insecure` skips certificate verification for its host and is set only by a human. */
export interface DocLink {
  url: string;
  insecure: boolean;
}

export interface DocSet {
  id: string;
  name: string;
  /** What belongs to the set: the refresher judges new documents by it. */
  scope: string;
  links: DocLink[];
  /** Created by the plan of AI-written documents. */
  generated: boolean;
  createdAt: string;
}

export type DocCheckStatus = 'current' | 'changed' | 'unverifiable';

export interface DocCheck {
  status: DocCheckStatus;
  at: string;
  /** Last time it was confirmed current; an unreachable site does not extend it. */
  lastCurrentAt: string | null;
  note: string;
  url: string | null;
  unverifiedChannel: boolean;
  runId: string | null;
}

/** `pages`: the document's own pages found by the check of its set, instead of its own link. */
export interface CatalogueEntry {
  url: string;
  title: string;
}

/** A catalogue entry with the decision on it: a set is complete only if every entry was looked at. */
export interface JudgedEntry extends CatalogueEntry {
  belongs: boolean;
  reason: string;
  judgedAt: string;
}

/** `entries`: one part of a catalogue, not the set's own check. */
export type DocRefreshTarget = { setId: string; entries?: CatalogueEntry[]; batch?: number } | { documentId: string; pages?: string[] };

export type DocProposalKind = 'update' | 'add' | 'replace' | 'retire' | 'link';
export type DocProposalStatus = 'pending' | 'applied' | 'rejected' | 'outdated';

export interface DocProposal {
  id: string;
  /** Entity id of the check that made it. */
  target: string;
  setId: string | null;
  documentId: string | null;
  kind: DocProposalKind;
  status: DocProposalStatus;
  title: string | null;
  edition: string | null;
  url: string | null;
  reason: string;
  quote: string | null;
  quoteUrl: string | null;
  /** Plain HTTP or an unverified certificate. */
  unverifiedChannel: boolean;
  /** The text was rewritten by AI instead of converted by the app. */
  restored: boolean;
  /** Share of the restored text's paragraphs found on the page. */
  coverage: number | null;
  /** The source shows only part of the document: a human uploads the file, the proposal cannot be applied. */
  incomplete: boolean;
  versionId: string | null;
  resultDocumentId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** Result of asking for a check: a job, or an answer without AI when the sources did not change. */
export interface DocRefreshStart {
  job: Job | null;
  /** Sources compared without AI; `job` is null when nothing changed. */
  compared: number;
  unchanged: boolean;
  failed: { url: string; error: string }[];
  /** Documents without text being read first; the check starts when they are done. */
  reading: number;
}

/** Requirements of different documents that probably say the same; nothing is merged. */
export interface RequirementRepeat {
  similarity: number;
  items: { key: string; section: string; citation: string; text: string; quote: string; documentId: string; documentTitle: string; url: string | null }[];
}

export interface DocRefreshEstimate {
  role: string;
  documents: number;
  links: string[];
  tokens: number;
  tokensSource: 'history' | 'config';
  maxTokensPerRun: number;
}

/** One planned document; kept on the document so regeneration keeps its slug and key prefix. */
export interface DocPlanEntry {
  slug: string;
  title: string;
  key_prefix: string;
  scope: string;
  /** Module names the document applies to; empty = all modules. */
  modules: string[];
  sections: string[];
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
  /** Clause of this edition as the document numbers it; the key stays the same across editions. */
  clause: string;
  quote: string;
  review: ReviewState;
  author: string;
  runId: string | null;
  updatedAt: string;
}

/** A requirement with its grounds: enough to name it as the reason of a task. */
export type CitedRequirement = RequirementItem & { documentTitle: string; citation: string };

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
  /** A PDF whose text was read by AI: quotes are matched against that reading, not against the file itself. */
  textByAi: boolean;
  /** The refresher proposal this version came from (SPEC §24). */
  proposal: DocProposal | null;
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
  /** Given in a merged session: cheaper and less reliable. */
  preliminary: boolean;
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
  /** The current verdict is preliminary. */
  preliminary: boolean;
  findingCount: number;
  /** Queued or running job that covers this cell. */
  activeJob: { id: string; status: JobStatus } | null;
}

export interface MatrixView {
  matrix: Matrix;
  head: string;
  modules: Module[];
  requirements: CitedRequirement[];
  cells: Cell[];
}

export type MatrixStage = 'triage' | 'verdicts';
/** Part of a matrix; unset fields do not narrow it. Modules go by id or name, requirements by id or key. */
export interface MatrixSlice {
  modules?: string[];
  requirements?: string[];
  section?: string;
  /** Only cells with a verdict of a merged session. */
  preliminary?: boolean;
}
/** Which cells a run covers: never checked (not_checked) or stale ones. */
export type MatrixScope = 'pending' | 'stale';

export type MatrixRunMode = 'usual' | 'economy';

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
  /** Absent where sessions are always the same. */
  mode?: MatrixRunMode;
  /** The other way to run these cells; set above `matrix.economy_above_tokens`. */
  alternative?: { mode: MatrixRunMode; sessions: number; tokens: number };
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
  /** SCA items (reachable vulnerabilities) the finding is linked to. */
  scaItems: ScaItemRef[];
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
  /** Link to an SCA item instead of a matrix cell. */
  scaItem: ScaItemRef | null;
  runId: string | null;
  author: string;
  createdAt: string;
}

export const POC_OUTCOMES = ['reproduced', 'not_reproduced', 'inconclusive'] as const;
export type PocOutcome = (typeof POC_OUTCOMES)[number];

export interface PocStep {
  /** Request or command that was run. */
  action: string;
  /** Excerpt of what came back. */
  result: string;
  note?: string;
}

export interface PocResult {
  id: string;
  findingId: string;
  outcome: PocOutcome;
  summary: string;
  steps: PocStep[];
  baseUrl: string;
  commitSha: string;
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
  citation: string | null;
}

export interface FindingDetails {
  finding: Finding;
  events: FindingEvent[];
  cells: CellLabel[];
  scaItems: (ScaItemRef & { moduleName: string | null })[];
  similar: SimilarFinding[];
  /** Matrix cells and fix sessions that ran for this finding. */
  runs: Run[];
  /** PoC tester: results (newest first), whether it can run and why not, its queued or running job, the latest env-setup job of the project. */
  poc: { results: PocResult[]; available: boolean; reason: string | null; baseUrl: string | null; job: Job | null; setup: Job | null };
}

export interface CellDetails {
  cell: Cell;
  module: Module | null;
  requirement: CitedRequirement | null;
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

/** Normalized kind of a scanner result: code pattern, leaked secret, misconfiguration, dependency CVE (for SCA). */
export const SIGNAL_KINDS = ['sast', 'secret', 'misconfig', 'vuln'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Result of the startup availability check of a configured scanner. */
export interface ScannerStatus {
  name: string;
  binary: string;
  format: string;
  enabled: boolean;
  available: boolean;
  version: string | null;
  /** Why it is unavailable or misconfigured. */
  error: string | null;
}

export type ScanStatus = 'running' | 'complete' | 'failed';

/** One scanner run at a commit over a set of paths (SPEC §4, Q10); immutable once finalized. */
export interface Scan {
  id: string;
  scanner: string;
  format: string;
  commitSha: string;
  /** Scanned paths relative to the repository root ("." = whole repository). */
  targets: string[];
  status: ScanStatus;
  toolVersion: string | null;
  /** Command lines actually run. */
  commands: string[][];
  error: string | null;
  /** Non-fatal problems reported by the tool (e.g. files it could not parse). */
  warnings: string[];
  findingCount: number;
  jobId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Normalized scanner result (`raw_findings`). */
export interface RawFinding {
  id: string;
  scanId: string;
  scanner: string;
  kind: SignalKind;
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  /** Path relative to the repository root. */
  file: string;
  line: number | null;
  endLine: number | null;
  cwe: string[];
  tags: string[];
  /** Stable identity across scans and commits (suppression scope "finding"). */
  fingerprint: string;
  /** Code excerpt; secrets are redacted. */
  snippet: string | null;
  /** Tool-specific extras; for `vuln`: package, version, vulnerability_id, fixed_version, purl, pkg_type, target. */
  data: Record<string, unknown>;
}

export const SUPPRESSION_SCOPES = ['finding', 'rule_glob', 'requirement_module'] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export interface SuppressionInput {
  scope: SuppressionScope;
  /** "finding" and "rule_glob": the signal the suppression is made from (gives scanner, rule, fingerprint, commit). */
  signalId?: string;
  /** "rule_glob": git pathspec globs the rule is suppressed in. */
  globs?: string[];
  /** "requirement_module". */
  requirementId?: string;
  moduleId?: string;
  reason: string;
  /** Optional expiry, ISO date (YYYY-MM-DD). */
  expiresAt?: string | null;
}

/** Human decision to drop scanner signals before AI (SPEC §4, Q18); append-only, revocation is recorded once. */
export interface Suppression {
  id: string;
  scope: SuppressionScope;
  scanner: string | null;
  ruleId: string | null;
  fingerprint: string | null;
  globs: string[];
  /** File and line of the suppressed signal ("finding" scope), for display. */
  file: string | null;
  line: number | null;
  requirementId: string | null;
  moduleId: string | null;
  reason: string;
  author: string;
  commitSha: string;
  /** Files the decision depends on (SPEC §5): a change of them makes it stale. */
  touchedFiles: string[];
  moduleGlobs: string[];
  expiresAt: string | null;
  /** Suppression this one re-confirmed. */
  replaces: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export type SuppressionState = 'active' | 'stale' | 'expired' | 'revoked';

export interface SuppressionView extends Suppression {
  /** State at the commit it was evaluated at. */
  state: SuppressionState;
  /** Files changed since the suppression's commit that made it stale. */
  changedFiles: string[];
  /** Human-readable scope. */
  label: string;
}

/** A signal as shown in the UI: which modules it belongs to and whether a suppression drops it. */
export interface SignalRow extends RawFinding {
  commitSha: string;
  moduleIds: string[];
  suppression: { id: string; state: SuppressionState; reason: string } | null;
}

export interface SignalsView {
  head: string;
  /** Commits with complete scans, newest first. */
  commits: { sha: string; scans: number; finishedAt: string }[];
  /** Commit shown (default: HEAD if scanned, else the newest scanned commit). */
  commit: string | null;
  /** Latest complete scan per scanner at the commit, plus running/failed ones. */
  scans: Scan[];
  signals: SignalRow[];
}

export interface SignalDetails {
  signal: SignalRow;
  scan: Scan;
  /** Suppressions that match the signal (any state). */
  suppressions: SuppressionView[];
}

/** Ready-made dependency file uploaded by a human for SCA (lock file, SBOM, scanner report). */
export interface ScaInput {
  id: string;
  /** null = whole project. */
  moduleId: string | null;
  filename: string;
  sha256: string;
  note: string;
  author: string;
  createdAt: string;
  removedAt: string | null;
  removedBy: string | null;
}

export type InventoryStatus = 'building' | 'complete' | 'failed';

/** What the inventory agent reported about how it resolved and checked dependencies. */
export interface InventorySummary {
  ecosystems: string[];
  tools: string[];
  /** Resolved dependencies checked (vulnerable or not). */
  dependenciesTotal: number;
  /** Build/lock files the inventory depends on (SPEC §5: a change makes it stale). */
  manifests: string[];
  notes: string | null;
}

/** Dependency inventory of a module built by one AI run (SPEC §4, Q11); immutable once finalized. */
export interface ScaInventory {
  id: string;
  moduleId: string;
  runId: string;
  commitSha: string;
  globs: string[];
  status: InventoryStatus;
  summary: InventorySummary | null;
  packageCount: number;
  vulnCount: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface ScaReport {
  id: string;
  inventoryId: string;
  /** Path the agent wrote the report to (relative to the run's checkout). */
  path: string;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface ScaVuln {
  id: string;
  packageId: string;
  /** CVE/GHSA/OSV id. */
  vulnId: string;
  aliases: string[];
  severity: Severity;
  title: string | null;
  fixedVersion: string | null;
  reportId: string;
}

/** A vulnerable package@version of an inventory. */
export interface ScaPackage {
  id: string;
  inventoryId: string;
  /** Identity across inventories: `<ecosystem>:<name>@<version>`. */
  key: string;
  ecosystem: string;
  name: string;
  version: string;
  /** Declared by the module itself (vs. transitive); null if unknown. */
  direct: boolean | null;
  /** How code refers to the package (Java packages, npm module, Python module...); empty = unknown. */
  importNames: string[];
  /** Build file that brings the package in, relative to the repository root. */
  manifest: string | null;
  purl: string | null;
  vulns: ScaVuln[];
}

export const SCA_STATUSES = ['reachable', 'not_reachable', 'needs_human'] as const;
export type ScaVerdictStatus = (typeof SCA_STATUSES)[number];
export type ScaItemStatus = 'not_checked' | ScaVerdictStatus;

/** Reachability verdict of an SCA item (module x package@version x vulnerability); append-only. */
export interface ScaVerdict {
  id: string;
  moduleId: string;
  packageKey: string;
  vulnId: string;
  status: ScaVerdictStatus;
  reason: string;
  evidence: Evidence[];
  commitSha: string;
  touchedFiles: string[];
  moduleGlobs: string[];
  runId: string | null;
  /** `auto` = prefilter without AI, `ai:<role>` or `human`. */
  author: string;
  createdAt: string;
}

export interface ScaItemRef {
  moduleId: string;
  packageKey: string;
  vulnId: string;
}

/** SCA item of the module's current inventory with its state. */
export interface ScaItem extends ScaItemRef {
  ecosystem: string;
  name: string;
  version: string;
  direct: boolean | null;
  vuln: ScaVuln;
  status: ScaItemStatus;
  stale: boolean;
  verdict: ScaVerdict | null;
  findingCount: number;
  activeJob: { id: string; status: JobStatus } | null;
}

export interface ScaModuleView {
  module: Module;
  inventory: ScaInventory | null;
  /** Code or build files the inventory depends on changed since its commit. */
  inventoryStale: boolean;
  /** Queued or running inventory job. */
  inventoryJob: { id: string; status: JobStatus; error: string | null; lastRunId: string | null } | null;
  /** Latest inventory job if it failed (shown with its error). */
  failedJob: { id: string; error: string | null; lastRunId: string | null } | null;
  items: ScaItem[];
}

export interface ScaView {
  head: string;
  modules: ScaModuleView[];
  inputs: ScaInput[];
}

export interface ScaItemDetails {
  item: ScaItem;
  module: Module | null;
  package: ScaPackage;
  inventory: ScaInventory;
  report: ScaReport | null;
  /** Newest first. */
  verdicts: (ScaVerdict & { run: Run | null })[];
  findings: Finding[];
  findingEvents: FindingEvent[];
  changedFiles: string[];
  /** Module files that refer to the package (prefilter at HEAD); null when the package has no import names. */
  importHits: string[] | null;
  config: EffectiveConfigView | null;
}

/** Which SCA items a run covers: never checked, stale ones, or the given ones. */
export type ScaScope = 'pending' | 'stale';

/** Dry-run of a reachability run (SPEC §7): prefilter without AI, then one session per module x package. */
export interface ScaEstimate {
  role: string;
  items: number;
  /** Items the prefilter closes as not_reachable (auto) without AI. */
  auto: number;
  sessions: number;
  tokensPerSession: number;
  tokensPerSessionSource: 'history' | 'config';
  tokens: number;
  maxTokensPerRun: number;
  packages: { moduleId: string; moduleName: string; packageKey: string; items: number }[];
  /** Items skipped because a queued or running job already covers them. */
  busy: number;
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
  agent?: { value: string; source: string };
  model?: { value: string; source: string };
  effort?: { value: string; source: string };
  instructions: { source: string; file?: string; text: string }[];
  allow: { value: string; source: string; denied: boolean }[];
  deny: { value: string; source: string }[];
  dirs: { value: string; source: string }[];
  env: { key: string; value: string; source: string }[];
  settings: { key: string; value: string; source: string }[];
}

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** What a branch check compares (SPEC §26): the changes `headRef` brings into `baseRef` against a set or a document. */
export type DiffCheckTarget = { setId: string } | { documentId: string };

export interface DiffCheckInput {
  baseRef: string;
  headRef: string;
  target: DiffCheckTarget;
}

export interface DiffCheck extends DiffCheckInput {
  id: string;
  /** Name of the set or document at the time of the check. */
  title: string;
  /** Fork point of the two branches, not the tip of `baseRef`: the diff is what a pull request shows. */
  baseSha: string;
  headSha: string;
  /** Approved versions whose accepted requirements are checked, sorted. */
  versionIds: string[];
  /** Files the branch changes. */
  files: string[];
  author: string;
  createdAt: string;
}

/** Verdict on one requirement of a check; append-only, the latest one counts. `finding` = the branch breaks it. */
export interface DiffVerdict {
  id: string;
  checkId: string;
  itemId: string;
  status: VerdictStatus;
  severity: Severity | null;
  reason: string;
  evidence: Evidence[];
  runId: string | null;
  author: string;
  createdAt: string;
}

export interface DiffCheckSummary extends DiffCheck {
  counts: Record<CellStatus, number>;
  /** Queued and running sessions. */
  activeJobs: number;
}

export interface DiffCheckView {
  check: DiffCheckSummary;
  rows: { item: RequirementItem; documentTitle: string; verdict: DiffVerdict | null }[];
}

/** What a schedule starts (SPEC §25). */
export type ScheduleAction =
  | { kind: 'task'; prompt: string; role: string; title?: string }
  /** `slice` narrows verdicts to its unchecked and stale cells; `scope` applies to the whole matrix. */
  | { kind: 'matrix'; matrixId: string; stage: MatrixStage; scope: MatrixScope; slice?: MatrixSlice & { cells?: string[] } }
  /** Empty list = all modules, null = the whole repository. */
  | { kind: 'scanners'; moduleIds: string[] | null }
  | { kind: 'sca_inventory'; moduleIds?: string[] }
  | { kind: 'sca'; scope?: ScaScope; moduleIds?: string[] }
  /** Without a module: all modules. */
  | { kind: 'entry_points'; moduleId?: string }
  /** Compares the sources first: an agent runs only when they changed. */
  | { kind: 'doc_refresh'; target: DocRefreshTarget }
  /** Starts only when the branches moved since the last check of these document versions. */
  | ({ kind: 'diff_check' } & DiffCheckInput);

export const SCHEDULE_ACTIONS = ['task', 'matrix', 'scanners', 'sca_inventory', 'sca', 'entry_points', 'doc_refresh', 'diff_check'] as const satisfies readonly ScheduleAction['kind'][];

export interface ScheduleInput {
  name: string;
  cron: string;
  action: ScheduleAction;
  /** Own limit of estimated tokens per firing; null = `schedules.max_tokens_per_firing`. */
  maxTokens: number | null;
}

export type ScheduleOutcome = 'started' | 'missed' | 'overlap' | 'over_limit' | 'nothing_to_do' | 'failed';

export interface ScheduleFiring {
  id: string;
  scheduleId: string;
  trigger: 'schedule' | 'manual';
  outcome: ScheduleOutcome;
  reason: string | null;
  jobIds: string[];
  /** Planned time; null for a manual firing. */
  scheduledAt: string | null;
  firedAt: string;
}

export interface Schedule extends ScheduleInput {
  id: string;
  enabled: boolean;
  /** Null while disabled. */
  nextAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastFiring: ScheduleFiring | null;
}

export interface CronPreview {
  /** Time zone the expression runs in: the one of the process. */
  timezone: string;
  next: string[];
}

export type AppEvent =
  | { type: 'jobs-changed'; projectId: string }
  | { type: 'runs-changed'; projectId: string }
  | { type: 'modules-changed'; projectId: string }
  | { type: 'audit-changed'; projectId: string }
  | { type: 'signals-changed'; projectId: string }
  | { type: 'sca-changed'; projectId: string }
  | { type: 'schedules-changed'; projectId: string }
  | { type: 'queue-changed'; state: QueueState }
  | { type: 'terminals-changed' }
  | { type: 'terminal-data'; terminalId: string; data: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; projectId?: string; recheck?: RecheckOffer };
