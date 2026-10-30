import type {
  AppEvent,
  CellDetails,
  ConfigFileInfo,
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
  MatrixStage,
  MatrixView,
  Module,
  ModuleRevision,
  ModuleSummary,
  ProjectInfo,
  QueueState,
  RequirementItem,
  ResultRecord,
  ReviewState,
  Run,
  Scan,
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
  importDocument(projectId: string, file: string, o: { documentId?: string; title?: string }): DocVersionView;
  docVersion(projectId: string, versionId: string): DocVersionView;
  retryExtraction(projectId: string, versionId: string): Job;
  setVersionState(projectId: string, versionId: string, status: 'review' | 'discarded'): void;
  reviewItems(projectId: string, versionId: string, itemIds: string[], review: ReviewState): void;
  saveItem(projectId: string, versionId: string, item: { key?: string | null; text: string; section: string; quote: string }): RequirementItem;
  approveVersion(projectId: string, versionId: string): void;

  listMatrices(projectId: string): Matrix[];
  saveMatrix(projectId: string, m: { id?: string; name: string; documentIds: string[]; moduleIds: string[] }): Matrix;
  matrixView(projectId: string, matrixId: string): MatrixView;
  cellDetails(projectId: string, cellId: string, matrixId?: string): CellDetails;
  estimateMatrix(projectId: string, matrixId: string, stage: MatrixStage, scope: MatrixScope): MatrixEstimate;
  runMatrix(projectId: string, matrixId: string, stage: MatrixStage, scope: MatrixScope): Job[];
  estimateRecheck(projectId: string, cells: string[], matrixId?: string): MatrixEstimate;
  recheckCells(projectId: string, cells: string[], matrixId?: string): Job[];
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

  /** Configured scanners and their availability (checked at startup; `refresh` re-checks). */
  scannerStatus(projectId: string, refresh?: boolean): ScannerStatus[];
  /** Queues scans at HEAD of modules (empty list = all modules) or of the whole repository (null). */
  runScanners(projectId: string, o: { moduleIds: string[] | null }): { jobs: Job[]; cached: string[]; unavailable: string[] };
  listScans(projectId: string): Scan[];
  signalsView(projectId: string, commit?: string | null): SignalsView;
  signalDetails(projectId: string, signalId: string): SignalDetails;
  listSuppressions(projectId: string): SuppressionView[];
  createSuppression(projectId: string, input: SuppressionInput): Suppression;
  revokeSuppression(projectId: string, id: string, reason: string): Suppression;
  /** Re-confirms a suppression at HEAD (new record, the old one is revoked). */
  renewSuppression(projectId: string, id: string, expiresAt?: string | null): Suppression;
  currentRequirements(projectId: string): (RequirementItem & { documentTitle: string })[];

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

/** Implementation in the main process: any method may be async. */
export type ApiImpl = {
  [K in ApiMethod]: (...args: Parameters<AiegisApi[K]>) => ReturnType<AiegisApi[K]> | Promise<ReturnType<AiegisApi[K]>>;
};

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
