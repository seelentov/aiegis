import type {
  AppEvent,
  ConfigFileInfo,
  EffectiveConfigView,
  EntryPointMap,
  Job,
  Module,
  ModuleRevision,
  ModuleSummary,
  ProjectInfo,
  QueueState,
  ResultRecord,
  Run,
  TerminalInfo,
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

  listTerminals(): TerminalInfo[];
  terminalSnapshot(terminalId: string): string;
  terminalWrite(terminalId: string, data: string): void;
  terminalResize(terminalId: string, cols: number, rows: number): void;
  terminalClose(terminalId: string): void;

  listRoles(projectId: string | null): { name: string; title: string; kind: string; mcp_access: string }[];
  defaultTaskRole(projectId: string | null): string;
  effectiveConfig(projectId: string | null, role: string, module?: string): EffectiveConfigView;
  /** Role of app-started task kind `tasks.<kind>`. */
  taskRole(projectId: string, kind: string): string;
  listConfigFiles(projectId: string | null): ConfigFileInfo[];
  readConfigFile(projectId: string | null, file: string): string;
  writeConfigFile(projectId: string | null, file: string, text: string): void;
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
