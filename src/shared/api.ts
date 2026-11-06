import type {
  AppEvent,
  CellDetails,
  DiffCheck,
  DiffCheckInput,
  DiffCheckSummary,
  DiffCheckView,
  ConfigFileInfo,
  DocLink,
  DocProposal,
  DocRefreshEstimate,
  DocRefreshStart,
  DocRefreshTarget,
  DocSet,
  CronPreview,
  DocumentSummary,
  DocVersionView,
  EffectiveConfigView,
  EntryPointMap,
  Evidence,
  Finding,
  FindingDetails,
  FindingInput,
  FindingStatus,
  Job,
  Language,
  Matrix,
  MatrixEstimate,
  MatrixScope,
  MatrixSlice,
  MatrixStage,
  MatrixView,
  Module,
  ModuleRevision,
  ModuleSummary,
  ProjectInfo,
  QueueState,
  CitedRequirement,
  DocInfo,
  JudgedEntry,
  RequirementItem,
  ResultRecord,
  ReviewState,
  Run,
  Scan,
  RequirementRepeat,
  Schedule,
  ScheduleFiring,
  ScheduleInput,
  ScaEstimate,
  ScaInput,
  ScaItemDetails,
  ScannerStatus,
  ScaScope,
  ScaVerdict,
  ScaVerdictStatus,
  ScaView,
  SignalDetails,
  SignalsView,
  Suppression,
  SuppressionInput,
  SuppressionView,
  TerminalInfo,
  Verdict,
  VerdictStatus,
} from './types';

/** Methods the renderer can call in the main process (one IPC channel per method). */
export interface AiegisApi {
  listProjects(): ProjectInfo[];
  addProject(dir: string): ProjectInfo;
  pickAndAddProject(): ProjectInfo | null;
  removeProject(projectId: string): void;

  listJobs(projectId: string): Job[];
  listRuns(projectId: string): Run[];
  runDetails(projectId: string, runId: string): { run: Run; results: ResultRecord[]; log: string | null };
  enqueueTask(projectId: string, task: { prompt: string; role: string; title?: string }): Job;
  cancelJob(projectId: string, jobId: string): void;
  retryJob(projectId: string, jobId: string): void;
  takeOver(projectId: string, jobId: string): string;
  queueState(): QueueState;
  resumeQueue(): void;

  newSession(projectId: string): string;
  openRun(projectId: string, runId: string): string;
  openExternal(projectId: string, runId: string): void;
  /** Opens a file (absolute, or relative to the project root) in VS Code, optionally at a line. */
  openInEditor(file: string, line?: number, projectId?: string): void;

  listModules(projectId: string): ModuleSummary[];
  moduleHistory(projectId: string, moduleId: string): ModuleRevision[];
  previewGlobs(projectId: string, globs: string[]): { count: number; sample: string[] };
  saveModule(projectId: string, m: { id?: string; name: string; globs: string[]; description: string }): Module;
  removeModule(projectId: string, moduleId: string, reason: string): void;
  enqueueModuleMarkup(projectId: string, hint: string): Job;
  enqueueEntryPoints(projectId: string, moduleId: string): Job;
  enqueueAllEntryPoints(projectId: string): Job[];
  entryPointMap(projectId: string, moduleId: string, snapshotId?: string): EntryPointMap;

  listDocuments(projectId: string): DocumentSummary[];
  /** File dialog for MD/PDF/DOCX; null if cancelled. */
  pickDocumentFile(): string | null;
  /** New document (title) or new version of `documentId`; queues requirement extraction. */
  importDocument(projectId: string, file: string, o: { documentId?: string; title?: string; setId?: string; source?: DocLink }): DocVersionView;
  listDocSets(projectId: string): DocSet[];
  /** `documentIds`: the whole membership of the set, when given. */
  saveDocSet(projectId: string, s: { id?: string; name: string; scope: string; links: DocLink[]; documentIds?: string[] }): DocSet;
  removeDocSet(projectId: string, setId: string): void;
  setDocumentSet(projectId: string, documentId: string, setId: string | null): void;
  setDocumentSource(projectId: string, documentId: string, source: DocLink | null): void;
  /** Out of force: requirements leave matrices, the refresher skips it, history stays. */
  retireDocument(projectId: string, documentId: string, reason: string): void;
  restoreDocument(projectId: string, documentId: string): void;
  estimateDocRefresh(projectId: string, target: DocRefreshTarget): DocRefreshEstimate;
  /** Checks a set or one document against its links; without AI when the sources did not change. */
  refreshDocuments(projectId: string, target: DocRefreshTarget, o: { force?: boolean }): DocRefreshStart;
  listDocProposals(projectId: string): DocProposal[];
  acceptDocProposal(projectId: string, id: string, o: { matrixIds?: string[] }): DocProposal;
  rejectDocProposal(projectId: string, id: string, reason: string): void;
  /** First filling of an empty set: all its "add" proposals. */
  acceptAllDocAdditions(projectId: string, setId: string): DocProposal[];
  /** Queues the plan of AI-written security documents covering the application; writers follow the plan. */
  enqueueDocPlan(projectId: string, hint: string): Job;
  /** Queues a rewrite of one AI-written document from its plan entry. */
  regenerateDocument(projectId: string, documentId: string, hint: string): Job;
  docVersion(projectId: string, versionId: string): DocVersionView;
  retryExtraction(projectId: string, versionId: string): Job;
  setVersionState(projectId: string, versionId: string, status: 'review' | 'discarded'): void;
  reviewItems(projectId: string, versionId: string, itemIds: string[], review: ReviewState): void;
  saveItem(projectId: string, versionId: string, item: { key?: string | null; text: string; section: string; clause?: string; quote: string }): RequirementItem;
  catalogueEntries(projectId: string, setId: string): JudgedEntry[];
  saveDocInfo(projectId: string, versionId: string, info: DocInfo): void;
  approveVersion(projectId: string, versionId: string): void;

  listMatrices(projectId: string): Matrix[];
  saveMatrix(projectId: string, m: { id?: string; name: string; documentIds: string[]; moduleIds: string[] }): Matrix;
  matrixView(projectId: string, matrixId: string): MatrixView;
  cellDetails(projectId: string, cellId: string, matrixId?: string): CellDetails;
  estimateMatrix(projectId: string, matrixId: string, stage: MatrixStage, scope: MatrixScope, force?: boolean): MatrixEstimate;
  runMatrix(projectId: string, matrixId: string, stage: MatrixStage, scope: MatrixScope, force?: boolean): Job[];
  /** Cells a verdict run of a slice covers: its unchecked and stale ones, or all of them when none is left. */
  matrixSlice(projectId: string, matrixId: string, slice: MatrixSlice): string[];
  estimateRecheck(projectId: string, cells: string[], matrixId?: string, force?: boolean): MatrixEstimate;
  recheckCells(projectId: string, cells: string[], matrixId?: string, force?: boolean): Job[];
  setVerdict(projectId: string, cellId: string, v: { status: VerdictStatus; reason: string; evidence: Evidence[] }): Verdict;

  listFindings(projectId: string): Finding[];
  findingDetails(projectId: string, findingId: string): FindingDetails;
  setFindingStatus(projectId: string, findingId: string, status: FindingStatus, reason: string): Finding;
  mergeFinding(projectId: string, sourceId: string, targetId: string): Finding;
  createFinding(projectId: string, cellId: string, input: Omit<FindingInput, 'moduleId'>): Finding;
  linkFinding(projectId: string, findingId: string, cellId: string): Finding;
  openFixSession(projectId: string, findingId: string): string;
  /** Queues the PoC tester on a suspected finding. */
  enqueuePoc(projectId: string, findingId: string): Job;
  /** Queues env-setup: an agent works out how to start the project and writes its test environment (one per project). */
  enqueuePocSetup(projectId: string): Job;

  /** Configured scanners and their availability (checked at startup; `refresh` re-checks). */
  scannerStatus(projectId: string, refresh?: boolean): ScannerStatus[];
  /** Queues scans at HEAD of modules (empty list = all modules) or of the whole repository (null). */
  runScanners(projectId: string, o: { moduleIds: string[] | null }): { jobs: Job[]; cached: string[]; unavailable: string[] };
  listScans(projectId: string): Scan[];
  /** Imports a SARIF 2.1.0 report as finished scans; `commit` is required when the report names none. */
  importSarif(projectId: string, file: string, o?: { commit?: string | null; sourceRoot?: string | null }): Scan[];
  /** File dialog for a SARIF report; null if cancelled. */
  pickSarifFile(): string | null;
  signalsView(projectId: string, commit?: string | null): SignalsView;
  signalDetails(projectId: string, signalId: string): SignalDetails;
  listSuppressions(projectId: string): SuppressionView[];
  createSuppression(projectId: string, input: SuppressionInput): Suppression;
  revokeSuppression(projectId: string, id: string, reason: string): Suppression;
  /** Re-confirms a suppression at HEAD (new record, the old one is revoked). */
  renewSuppression(projectId: string, id: string, expiresAt?: string | null): Suppression;
  currentRequirements(projectId: string): CitedRequirement[];
  /** Requirements of different documents that probably say the same; nothing is merged. */
  requirementRepeats(projectId: string): RequirementRepeat[];

  /** Modules with their current dependency inventory and SCA items. */
  scaView(projectId: string): ScaView;
  scaItemDetails(projectId: string, itemId: string): ScaItemDetails;
  /** File dialog for a dependency file (lock file, SBOM, report); null if cancelled. */
  pickScaInputFile(): string | null;
  addScaInput(projectId: string, file: string, o: { moduleId: string | null; note: string }): ScaInput;
  removeScaInput(projectId: string, id: string): ScaInput;
  /** Queues inventories of modules (default: all) at HEAD. */
  enqueueScaInventories(projectId: string, moduleIds?: string[]): Job[];
  estimateSca(projectId: string, o: { scope?: ScaScope; moduleIds?: string[]; items?: string[] }): ScaEstimate;
  runSca(projectId: string, o: { scope?: ScaScope; moduleIds?: string[]; items?: string[] }): { auto: number; jobs: Job[] };
  setScaVerdict(projectId: string, itemId: string, v: { status: ScaVerdictStatus; reason: string; evidence: Evidence[] }): ScaVerdict;
  createScaFinding(projectId: string, itemId: string, input: Omit<FindingInput, 'moduleId'>): Finding;
  linkScaFinding(projectId: string, findingId: string, itemId: string): Finding;
  /** Absolute path of a stored inventory report. */
  scaReportPath(projectId: string, reportId: string): string;

  /** Local and remote-tracking branches of the project. */
  listBranches(projectId: string): string[];
  estimateDiffCheck(projectId: string, input: DiffCheckInput): MatrixEstimate;
  /** Checks the changes `headRef` brings into `baseRef` against the current requirements of a set or a document. */
  runDiffCheck(projectId: string, input: DiffCheckInput): { check: DiffCheck; jobs: Job[] };
  listDiffChecks(projectId: string): DiffCheckSummary[];
  diffCheckView(projectId: string, checkId: string): DiffCheckView;

  listSchedules(projectId: string): Schedule[];
  scheduleDetails(projectId: string, id: string): Schedule;
  /** Newest firings first. */
  scheduleHistory(projectId: string, id: string, limit?: number): ScheduleFiring[];
  createSchedule(projectId: string, input: ScheduleInput): Schedule;
  updateSchedule(projectId: string, id: string, patch: Partial<ScheduleInput>): Schedule;
  enableSchedule(projectId: string, id: string): Schedule;
  disableSchedule(projectId: string, id: string): Schedule;
  /** The firings stay in the history. */
  removeSchedule(projectId: string, id: string): void;
  /** Fires now with the checks of a planned firing; the planned time stays. */
  runSchedule(projectId: string, id: string): ScheduleFiring;
  /** Next times of an expression; throws when it is invalid or fires too often. */
  cronPreview(projectId: string, cron: string): CronPreview;

  listTerminals(): TerminalInfo[];
  terminalSnapshot(terminalId: string): string;
  terminalWrite(terminalId: string, data: string): void;
  terminalResize(terminalId: string, cols: number, rows: number): void;
  terminalClose(terminalId: string): void;

  listRoles(projectId: string | null): { name: string; title: string; kind: string; mcp_access: string }[];
  defaultTaskRole(projectId: string | null): string;
  effectiveConfig(projectId: string | null, role: string, module?: string, extra?: { matrix?: string; item?: string }): EffectiveConfigView;
  /** Role of app-started task kind `tasks.<kind>`. */
  taskRole(projectId: string, kind: string): string;
  listConfigFiles(projectId: string | null): ConfigFileInfo[];
  readConfigFile(projectId: string | null, file: string): string;
  writeConfigFile(projectId: string | null, file: string, text: string): void;
  uiLanguage(): Language;
}

export type ApiMethod = keyof AiegisApi;

/** Methods of the desktop app only: they need a screen or a PTY (SPEC §23). */
export const UI_METHODS = [
  'pickAndAddProject',
  'pickDocumentFile',
  'pickScaInputFile',
  'pickSarifFile',
  'newSession',
  'openRun',
  'openExternal',
  'takeOver',
  'openFixSession',
  'openInEditor',
  'terminalWrite',
  'terminalResize',
  'uiLanguage',
] as const satisfies readonly ApiMethod[];
export type UiMethod = (typeof UI_METHODS)[number];
export type CoreMethod = Exclude<ApiMethod, UiMethod>;

/** Implementation in the main process: any method may be async. */
export type ApiImpl = {
  [K in ApiMethod]: (...args: Parameters<AiegisApi[K]>) => ReturnType<AiegisApi[K]> | Promise<ReturnType<AiegisApi[K]>>;
};

/** What the desktop app and the service share. */
export type CoreApi = Pick<ApiImpl, CoreMethod>;

/** Async view of the API as seen from the renderer. */
export type AsyncApi = {
  [K in ApiMethod]: (...args: Parameters<AiegisApi[K]>) => Promise<Awaited<ReturnType<AiegisApi[K]>>>;
};

export interface Bridge {
  invoke(method: ApiMethod, ...args: unknown[]): Promise<unknown>;
  onEvent(cb: (ev: AppEvent) => void): () => void;
}

export const EVENT_CHANNEL = 'aiegis:event';
export const invokeChannel = (m: ApiMethod) => `aiegis:${m}`;
