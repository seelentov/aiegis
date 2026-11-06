import type { AiegisApi, CoreMethod } from '../shared/api';
import { FINDING_STATUSES, SCA_STATUSES, SEVERITIES, SUPPRESSION_SCOPES, VERDICT_STATUSES, type DiffCheckInput, type DocRefreshTarget, type Evidence, type FindingInput, type MatrixScope, type MatrixSlice, type MatrixStage, type ReviewState, type SuppressionInput, SCHEDULE_ACTIONS, type ScheduleAction, type ScheduleInput } from '../shared/types';

/** Parsed command line of one command. */
export interface Input {
  pos: string[];
  /** Last value of a flag. */
  one(flag: string): string | undefined;
  /** All values of a repeatable flag. */
  all(flag: string): string[];
  has(flag: string): boolean;
  /** Text read from stdin. */
  stdin(): Promise<string>;
}

export interface Ctx {
  call<M extends CoreMethod>(method: M, ...args: Parameters<AiegisApi[M]>): Promise<Awaited<ReturnType<AiegisApi[M]>>>;
  /** Project of the command; throws when it cannot be told. */
  pid(): string;
  /** Project of the command, or null for the global scope. */
  scope(): string | null;
  /** Absolute form of a path argument: the service runs in another directory. */
  abs(file: string): string;
  /** Shows an estimate and waits for the user's consent (SPEC §7). */
  confirm(estimate: unknown): Promise<void>;
}

export interface Command {
  name: string;
  /** Positional arguments and flags: `<required>`, `[optional]`, `<many...>`, `--flag <value>`, `--switch`. */
  usage: string;
  help: string;
  run(a: Input, c: Ctx): Promise<unknown>;
  /** Result is a list shown as a table of these fields (dotted paths). */
  columns?: string[];
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${what} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

function refreshTarget(a: Input): DocRefreshTarget {
  const setId = a.one('set');
  const documentId = a.one('document');
  if (Boolean(setId) === Boolean(documentId)) throw new Error('pass one of --set and --document');
  return setId ? { setId } : { documentId: documentId! };
}

function required(a: Input, flag: string): string {
  const v = a.one(flag);
  if (v === undefined) throw new Error(`--${flag} is required`);
  return v;
}

function diffInput(a: Input): DiffCheckInput {
  return { baseRef: required(a, 'base'), headRef: required(a, 'head'), target: refreshTarget(a) };
}

async function matrixId(c: Ctx, ref: string): Promise<string> {
  const m = (await c.call('listMatrices', c.pid())).find((x) => x.id === ref || x.name === ref);
  if (!m) throw new Error(`matrix ${ref} not found`);
  return m.id;
}

async function moduleId(c: Ctx, ref: string): Promise<string> {
  const m = (await c.call('listModules', c.pid())).find((x) => x.id === ref || x.name === ref);
  if (!m) throw new Error(`module ${ref} not found`);
  return m.id;
}

const moduleIds = (c: Ctx, refs: string[]) => Promise.all(refs.map((r) => moduleId(c, r)));

/** `file[:line]` of `--evidence`. */
function evidence(a: Input): Evidence[] {
  return a.all('evidence').map((e) => {
    const m = /^(.*):(\d+)$/.exec(e);
    return m ? { file: m[1], line: Number(m[2]) } : { file: e };
  });
}

function findingInput(a: Input): Omit<FindingInput, 'moduleId'> {
  return {
    title: required(a, 'title'),
    description: required(a, 'description'),
    severity: oneOf(a.one('severity'), SEVERITIES, '--severity'),
    cwe: a.one('cwe') ?? null,
    entryPoint: a.one('entry-point') ?? null,
    files: evidence(a),
    recommendation: a.one('recommendation') ?? null,
  };
}

const FINDING_FLAGS = '--title <text> --description <text> --severity <level> [--cwe <id>] [--entry-point <text>] [--recommendation <text>] [--evidence <file[:line]>...]';

async function runMatrix(a: Input, c: Ctx): Promise<unknown> {
  const pid = c.pid();
  const matrix = await matrixId(c, a.pos[0]);
  const stage = oneOf<MatrixStage>(a.one('stage') ?? 'verdicts', ['triage', 'verdicts'], '--stage');
  const slice: MatrixSlice = {
    modules: a.has('module') ? a.all('module') : undefined,
    requirements: a.has('requirement') ? a.all('requirement') : undefined,
    section: a.one('section'),
    preliminary: a.has('preliminary') || undefined,
  };
  const force = a.has('force');
  if (slice.modules || slice.requirements || slice.section !== undefined || slice.preliminary) {
    if (stage === 'triage') throw new Error('triage runs on the whole matrix');
    const cells = await c.call('matrixSlice', pid, matrix, slice);
    if (!cells.length) throw new Error('no cells in this slice');
    await c.confirm(await c.call('estimateRecheck', pid, cells, matrix, force));
    return c.call('recheckCells', pid, cells, matrix, force);
  }
  const scope = oneOf<MatrixScope>(a.one('scope') ?? 'pending', ['pending', 'stale'], '--scope');
  await c.confirm(await c.call('estimateMatrix', pid, matrix, stage, scope, force));
  return c.call('runMatrix', pid, matrix, stage, scope, force);
}

const scaOptions = async (a: Input, c: Ctx) => ({
  scope: a.has('scope') ? oneOf<'pending' | 'stale'>(a.one('scope'), ['pending', 'stale'], '--scope') : undefined,
  moduleIds: a.has('module') ? await moduleIds(c, a.all('module')) : undefined,
  items: a.has('item') ? a.all('item') : undefined,
});

async function scheduleId(c: Ctx, ref: string): Promise<string> {
  const s = (await c.call('listSchedules', c.pid())).find((x) => x.id === ref || x.name === ref);
  if (!s) throw new Error(`schedule ${ref} not found`);
  return s.id;
}

const SCHEDULE_FLAGS =
  '[--max-tokens <n|default>] [--prompt <text>] [--role <role>] [--title <text>] [--matrix <matrix>] [--stage <triage|verdicts>] [--scope <pending|stale>] [--module <name>...] [--requirement <key>...] [--section <name>] [--cell <id>...] [--repository] [--base <branch>] [--head <branch>] [--set <id>] [--document <id>]';

/** Action of `--action` and its flags; the core validates the result. */
async function scheduleAction(a: Input, c: Ctx): Promise<ScheduleAction> {
  const kind = oneOf(a.one('action'), SCHEDULE_ACTIONS, '--action');
  const mods = a.has('module') ? await moduleIds(c, a.all('module')) : undefined;
  switch (kind) {
    case 'task':
      return { kind, prompt: required(a, 'prompt'), role: a.one('role') ?? (await c.call('defaultTaskRole', c.pid())), title: a.one('title') };
    case 'matrix': {
      const slice = {
        modules: mods,
        requirements: a.has('requirement') ? a.all('requirement') : undefined,
        section: a.one('section'),
        cells: a.has('cell') ? a.all('cell') : undefined,
      };
      return {
        kind,
        matrixId: await matrixId(c, required(a, 'matrix')),
        stage: oneOf<MatrixStage>(a.one('stage') ?? 'verdicts', ['triage', 'verdicts'], '--stage'),
        scope: oneOf<MatrixScope>(a.one('scope') ?? 'pending', ['pending', 'stale'], '--scope'),
        slice: Object.values(slice).some((v) => v !== undefined) ? slice : undefined,
      };
    }
    case 'diff_check':
      return { kind, ...diffInput(a) };
    case 'fix_verify':
      return { kind };
    case 'scanners':
      return { kind, moduleIds: a.has('repository') ? null : (mods ?? []) };
    case 'sca_inventory':
      return { kind, moduleIds: mods };
    case 'sca':
      return { kind, scope: a.has('scope') ? oneOf<'pending' | 'stale'>(a.one('scope'), ['pending', 'stale'], '--scope') : undefined, moduleIds: mods };
    case 'entry_points':
      if ((mods?.length ?? 0) > 1) throw new Error('entry_points takes one --module, or none for all modules');
      return { kind, moduleId: mods?.[0] };
    case 'doc_refresh':
      return { kind, target: refreshTarget(a) };
  }
}

function maxTokens(a: Input): number | null {
  const v = a.one('max-tokens');
  if (v === undefined || v === 'default') return null;
  // NaN would reach the core as null, the default limit.
  if (!/^[1-9]\d*$/.test(v)) throw new Error('--max-tokens must be a positive integer or "default"');
  return Number(v);
}

/** Every method of the core API has a command: a new one does not compile until it is added here or to UI_METHODS. */
export const COMMANDS: Record<CoreMethod, Command> = {
  listProjects: { name: 'project list', usage: '', help: 'List projects', columns: ['id', 'name', 'root'], run: (_a, c) => c.call('listProjects') },
  addProject: { name: 'project add', usage: '<path>', help: 'Register a git repository', run: (a, c) => c.call('addProject', c.abs(a.pos[0])) },
  removeProject: { name: 'project remove', usage: '', help: 'Forget the project', run: (_a, c) => c.call('removeProject', c.pid()) },

  listJobs: { name: 'job list', usage: '', help: 'List jobs', columns: ['id', 'status', 'role', 'title'], run: (_a, c) => c.call('listJobs', c.pid()) },
  enqueueTask: {
    name: 'job add',
    usage: '<prompt> [--role <role>] [--title <text>]',
    help: 'Queue a free-form agent task',
    run: async (a, c) => c.call('enqueueTask', c.pid(), { prompt: a.pos[0], role: a.one('role') ?? (await c.call('defaultTaskRole', c.pid())), title: a.one('title') }),
  },
  cancelJob: { name: 'job cancel', usage: '<job>', help: 'Cancel a job', run: (a, c) => c.call('cancelJob', c.pid(), a.pos[0]) },
  retryJob: { name: 'job retry', usage: '<job>', help: 'Retry a job', run: (a, c) => c.call('retryJob', c.pid(), a.pos[0]) },
  queueState: { name: 'queue state', usage: '', help: 'Show the queue', run: (_a, c) => c.call('queueState') },
  resumeQueue: { name: 'queue resume', usage: '', help: 'Resume a paused queue', run: (_a, c) => c.call('resumeQueue') },
  listRuns: { name: 'run list', usage: '', help: 'List runs', columns: ['id', 'status', 'role', 'kind', 'startedAt'], run: (_a, c) => c.call('listRuns', c.pid()) },
  runDetails: { name: 'run show', usage: '<run>', help: 'Show a run with its results and log', run: (a, c) => c.call('runDetails', c.pid(), a.pos[0]) },

  listModules: { name: 'module list', usage: '', help: 'List modules', columns: ['id', 'name', 'description'], run: (_a, c) => c.call('listModules', c.pid()) },
  moduleHistory: { name: 'module history', usage: '<module>', help: 'Show the revisions of a module', run: async (a, c) => c.call('moduleHistory', c.pid(), await moduleId(c, a.pos[0])) },
  previewGlobs: { name: 'module preview', usage: '<glob...>', help: 'Show the files globs match', run: (a, c) => c.call('previewGlobs', c.pid(), a.pos) },
  saveModule: {
    name: 'module save',
    usage: '<name> --glob <glob>... [--description <text>] [--id <module>]',
    help: 'Create or change a module',
    run: (a, c) => c.call('saveModule', c.pid(), { id: a.one('id'), name: a.pos[0], globs: a.all('glob'), description: a.one('description') ?? '' }),
  },
  removeModule: { name: 'module remove', usage: '<module> <reason>', help: 'Remove a module', run: async (a, c) => c.call('removeModule', c.pid(), await moduleId(c, a.pos[0]), a.pos[1]) },
  enqueueModuleMarkup: { name: 'module parse', usage: '[--hint <text>]', help: 'Queue AI markup of modules', run: (a, c) => c.call('enqueueModuleMarkup', c.pid(), a.one('hint') ?? '') },
  enqueueEntryPoints: { name: 'entry-points build', usage: '<module>', help: 'Queue the entry point map of a module', run: async (a, c) => c.call('enqueueEntryPoints', c.pid(), await moduleId(c, a.pos[0])) },
  enqueueAllEntryPoints: { name: 'entry-points build-all', usage: '', help: 'Queue the entry point maps of all modules', run: (_a, c) => c.call('enqueueAllEntryPoints', c.pid()) },
  entryPointMap: { name: 'entry-points show', usage: '<module> [--snapshot <id>]', help: 'Show an entry point map', run: async (a, c) => c.call('entryPointMap', c.pid(), await moduleId(c, a.pos[0]), a.one('snapshot')) },

  listDocuments: { name: 'doc list', usage: '', help: 'List documents', columns: ['id', 'title', 'current.status'], run: (_a, c) => c.call('listDocuments', c.pid()) },
  importDocument: {
    name: 'doc import',
    usage: '<file> [--title <text>] [--document <id>] [--set <id>] [--source <url>] [--insecure]',
    help: 'Upload a document, or a new version of one; queues requirement extraction',
    run: (a, c) => c.call('importDocument', c.pid(), c.abs(a.pos[0]), { documentId: a.one('document'), title: a.one('title'), setId: a.one('set'), source: a.one('source') ? { url: a.one('source')!, insecure: a.has('insecure') } : undefined }),
  },
  listDocSets: { name: 'doc-set list', usage: '', help: 'List document sets', columns: ['id', 'name', 'links.length'], run: (_a, c) => c.call('listDocSets', c.pid()) },
  saveDocSet: {
    name: 'doc-set save',
    usage: '<name> [--id <set>] [--scope <text>] [--link <url>] [--insecure-link <url>] [--document <id>]',
    help: 'Create or update a document set; --insecure-link does not verify the certificate of that host; --document lists its whole membership',
    run: (a, c) =>
      c.call('saveDocSet', c.pid(), {
        id: a.one('id'),
        name: a.pos[0],
        scope: a.one('scope') ?? '',
        links: [...a.all('link').map((url) => ({ url, insecure: false })), ...a.all('insecure-link').map((url) => ({ url, insecure: true }))],
        documentIds: a.has('document') ? a.all('document') : undefined,
      }),
  },
  removeDocSet: { name: 'doc-set remove', usage: '<set>', help: 'Remove a set; its documents stay, outside any set', run: (a, c) => c.call('removeDocSet', c.pid(), a.pos[0]) },
  setDocumentSet: { name: 'doc-set assign', usage: '<document> [--set <id>]', help: 'Move a document to a set, or out of any set without --set', run: (a, c) => c.call('setDocumentSet', c.pid(), a.pos[0], a.one('set') ?? null) },
  setDocumentSource: {
    name: 'doc source',
    usage: '<document> [url] [--insecure]',
    help: 'Set the link of a document, or clear it; --insecure does not verify the certificate of its host',
    run: (a, c) => c.call('setDocumentSource', c.pid(), a.pos[0], a.pos[1] ? { url: a.pos[1], insecure: a.has('insecure') } : null),
  },
  retireDocument: { name: 'doc retire', usage: '<document> <reason>', help: 'Take a document out of force: it leaves matrices and checks, history stays', run: (a, c) => c.call('retireDocument', c.pid(), a.pos[0], a.pos[1]) },
  restoreDocument: { name: 'doc restore', usage: '<document>', help: 'Bring a document back into force', run: (a, c) => c.call('restoreDocument', c.pid(), a.pos[0]) },
  retireRequirements: { name: 'doc item-retire', usage: '<reason> <requirement...>', help: 'Take requirements out of force: they leave matrices and checks, their document and history stay', run: (a, c) => c.call('retireRequirements', c.pid(), a.pos.slice(1), a.pos[0]) },
  restoreRequirements: { name: 'doc item-restore', usage: '<requirement...>', help: 'Bring requirements back into force', run: (a, c) => c.call('restoreRequirements', c.pid(), a.pos) },
  estimateDocRefresh: { name: 'doc check-estimate', usage: '(--set <id> | --document <id>)', help: 'Estimate a document check; nothing runs', run: (a, c) => c.call('estimateDocRefresh', c.pid(), refreshTarget(a)) },
  refreshDocuments: {
    name: 'doc check',
    usage: '(--set <id> | --document <id>) [--force]',
    help: 'Check a set or one document against its links; without AI when the sources did not change, unless --force',
    run: (a, c) => c.call('refreshDocuments', c.pid(), refreshTarget(a), { force: a.has('force') }),
  },
  listDocProposals: { name: 'doc-proposal list', usage: '', help: 'List changes proposed by document checks', columns: ['id', 'kind', 'status', 'title', 'edition', 'url'], run: (_a, c) => c.call('listDocProposals', c.pid()) },
  acceptDocProposal: {
    name: 'doc-proposal accept',
    usage: '<proposal> [--matrix <id>]',
    help: 'Apply a proposal; a new document joins the given matrices, by default those with documents of its set',
    run: (a, c) => c.call('acceptDocProposal', c.pid(), a.pos[0], { matrixIds: a.has('matrix') ? a.all('matrix') : undefined }),
  },
  rejectDocProposal: { name: 'doc-proposal reject', usage: '<proposal> [reason]', help: 'Reject a proposal; it is not proposed again while the source stays the same', run: (a, c) => c.call('rejectDocProposal', c.pid(), a.pos[0], a.pos[1] ?? '') },
  acceptAllDocAdditions: { name: 'doc-proposal accept-additions', usage: '<set>', help: 'Apply all additions to an empty set', run: (a, c) => c.call('acceptAllDocAdditions', c.pid(), a.pos[0]) },
  enqueueDocPlan: { name: 'doc plan', usage: '[--hint <text>]', help: 'Queue AI-written security documents', run: (a, c) => c.call('enqueueDocPlan', c.pid(), a.one('hint') ?? '') },
  regenerateDocument: { name: 'doc rewrite', usage: '<document> [--hint <text>]', help: 'Queue a rewrite of an AI-written document', run: (a, c) => c.call('regenerateDocument', c.pid(), a.pos[0], a.one('hint') ?? '') },
  docVersion: { name: 'doc show', usage: '<version>', help: 'Show a document version with its items', run: (a, c) => c.call('docVersion', c.pid(), a.pos[0]) },
  retryExtraction: { name: 'doc retry', usage: '<version>', help: 'Retry requirement extraction', run: (a, c) => c.call('retryExtraction', c.pid(), a.pos[0]) },
  setVersionState: { name: 'doc state', usage: '<version> <review|discarded>', help: 'Send a version to review or discard it', run: (a, c) => c.call('setVersionState', c.pid(), a.pos[0], oneOf(a.pos[1], ['review', 'discarded'] as const, 'state')) },
  reviewItems: {
    name: 'doc review',
    usage: '<version> <pending|accepted|rejected> <item...>',
    help: 'Review extracted items',
    run: (a, c) => c.call('reviewItems', c.pid(), a.pos[0], a.pos.slice(2), oneOf<ReviewState>(a.pos[1], ['pending', 'accepted', 'rejected'], 'review')),
  },
  saveItem: {
    name: 'doc item',
    usage: '<version> --text <text> --section <name> [--key <key>] [--clause <text>] [--quote <text>]',
    help: 'Add or change a requirement',
    run: (a, c) => c.call('saveItem', c.pid(), a.pos[0], { key: a.one('key') ?? null, text: required(a, 'text'), section: required(a, 'section'), clause: a.one('clause') ?? '', quote: a.one('quote') ?? '' }),
  },
  catalogueEntries: { name: 'doc catalogue', usage: '<set>', help: 'Show the decision on every catalogue entry of a set', columns: ['belongs', 'title', 'reason'], run: (a, c) => c.call('catalogueEntries', c.pid(), a.pos[0]) },
  saveDocInfo: {
    name: 'doc info',
    usage: '<version> [--name <text>] [--number <text>] [--date <text>] [--edition <text>]',
    help: 'Set how a version is cited; a value left out becomes empty',
    run: (a, c) => c.call('saveDocInfo', c.pid(), a.pos[0], { name: a.one('name') ?? '', number: a.one('number') ?? '', date: a.one('date') ?? '', edition: a.one('edition') ?? '' }),
  },
  approveVersion: { name: 'doc approve', usage: '<version>', help: 'Approve a reviewed version', run: (a, c) => c.call('approveVersion', c.pid(), a.pos[0]) },
  requirementRepeats: { name: 'doc repeats', usage: '', help: 'Show requirements of different documents that probably say the same', run: (_a, c) => c.call('requirementRepeats', c.pid()) },
  currentRequirements: { name: 'doc requirements', usage: '', help: 'List current requirements', columns: ['key', 'citation', 'text'], run: (_a, c) => c.call('currentRequirements', c.pid()) },

  listMatrices: { name: 'matrix list', usage: '', help: 'List matrices', columns: ['id', 'name'], run: (_a, c) => c.call('listMatrices', c.pid()) },
  saveMatrix: {
    name: 'matrix save',
    usage: '<name> --document <id>... --module <name>... [--id <matrix>]',
    help: 'Create or change a matrix',
    run: async (a, c) => c.call('saveMatrix', c.pid(), { id: a.one('id'), name: a.pos[0], documentIds: a.all('document'), moduleIds: await moduleIds(c, a.all('module')) }),
  },
  matrixView: { name: 'matrix show', usage: '<matrix>', help: 'Show a matrix', run: async (a, c) => c.call('matrixView', c.pid(), await matrixId(c, a.pos[0])) },
  matrixSlice: {
    name: 'matrix slice',
    usage: '<matrix> [--module <name>...] [--requirement <key>...] [--section <name>] [--preliminary]',
    help: 'List the cells a slice run would cover',
    run: async (a, c) =>
      c.call('matrixSlice', c.pid(), await matrixId(c, a.pos[0]), {
        modules: a.has('module') ? a.all('module') : undefined,
        requirements: a.has('requirement') ? a.all('requirement') : undefined,
        section: a.one('section'),
        preliminary: a.has('preliminary') || undefined,
      }),
  },
  estimateMatrix: {
    name: 'matrix estimate',
    usage: '<matrix> [--stage <triage|verdicts>] [--scope <pending|stale>] [--force]',
    help: 'Estimate a stage of a matrix; --force estimates the usual sessions of a large run',
    run: async (a, c) => c.call('estimateMatrix', c.pid(), await matrixId(c, a.pos[0]), oneOf<MatrixStage>(a.one('stage') ?? 'verdicts', ['triage', 'verdicts'], '--stage'), oneOf<MatrixScope>(a.one('scope') ?? 'pending', ['pending', 'stale'], '--scope'), a.has('force')),
  },
  runMatrix: {
    name: 'matrix run',
    usage: '<matrix> [--stage <triage|verdicts>] [--scope <pending|stale>] [--module <name>...] [--requirement <key>...] [--section <name>] [--preliminary] [--force]',
    help: 'Run a stage of a whole matrix, or verdicts of a module, requirement, section or preliminary cells; --force keeps the usual sessions of a large run',
    run: runMatrix,
  },
  estimateRecheck: { name: 'cell estimate', usage: '<cell...> [--matrix <matrix>] [--force]', help: 'Estimate a recheck of cells', run: async (a, c) => c.call('estimateRecheck', c.pid(), a.pos, a.has('matrix') ? await matrixId(c, a.one('matrix')!) : undefined, a.has('force')) },
  recheckCells: {
    name: 'cell run',
    usage: '<cell...> [--matrix <matrix>] [--force]',
    help: 'Run verdicts of cells (<module id>/<requirement id>)',
    run: async (a, c) => {
      const matrix = a.has('matrix') ? await matrixId(c, a.one('matrix')!) : undefined;
      await c.confirm(await c.call('estimateRecheck', c.pid(), a.pos, matrix, a.has('force')));
      return c.call('recheckCells', c.pid(), a.pos, matrix, a.has('force'));
    },
  },
  cellDetails: { name: 'cell show', usage: '<cell> [--matrix <matrix>]', help: 'Show a cell', run: async (a, c) => c.call('cellDetails', c.pid(), a.pos[0], a.has('matrix') ? await matrixId(c, a.one('matrix')!) : undefined) },
  setVerdict: {
    name: 'cell verdict',
    usage: '<cell> <status> <reason> [--evidence <file[:line]>...]',
    help: 'Set a human verdict',
    run: (a, c) => c.call('setVerdict', c.pid(), a.pos[0], { status: oneOf(a.pos[1], VERDICT_STATUSES, 'status'), reason: a.pos[2], evidence: evidence(a) }),
  },

  listFindings: { name: 'finding list', usage: '', help: 'List findings', columns: ['id', 'status', 'severity', 'title'], run: (_a, c) => c.call('listFindings', c.pid()) },
  findingDetails: { name: 'finding show', usage: '<finding>', help: 'Show a finding', run: (a, c) => c.call('findingDetails', c.pid(), a.pos[0]) },
  setFindingStatus: { name: 'finding status', usage: '<finding> <status> <reason>', help: 'Change the status of a finding', run: (a, c) => c.call('setFindingStatus', c.pid(), a.pos[0], oneOf(a.pos[1], FINDING_STATUSES, 'status'), a.pos[2]) },
  mergeFinding: { name: 'finding merge', usage: '<source> <target>', help: 'Merge a finding into another', run: (a, c) => c.call('mergeFinding', c.pid(), a.pos[0], a.pos[1]) },
  createFinding: { name: 'finding create', usage: `<cell> ${FINDING_FLAGS}`, help: 'Create a finding on a cell', run: (a, c) => c.call('createFinding', c.pid(), a.pos[0], findingInput(a)) },
  linkFinding: { name: 'finding link', usage: '<finding> <cell>', help: 'Link a finding to a cell', run: (a, c) => c.call('linkFinding', c.pid(), a.pos[0], a.pos[1]) },
  enqueuePoc: { name: 'finding poc', usage: '<finding>', help: 'Queue the PoC tester on a finding', run: (a, c) => c.call('enqueuePoc', c.pid(), a.pos[0]) },
  findingsFixState: { name: 'finding fix-state', usage: '', help: 'Show whether the files of live findings changed since their last fix check', run: (_a, c) => c.call('findingsFixState', c.pid()) },
  estimateFixVerify: { name: 'finding fix-estimate', usage: '<finding...>', help: 'Estimate fix checks of findings', run: (a, c) => c.call('estimateFixVerify', c.pid(), a.pos) },
  runFixVerify: {
    name: 'finding fix-check',
    usage: '<finding...>',
    help: 'Queue a clean session per finding that judges at HEAD whether it is closed',
    columns: ['id', 'status', 'title'],
    run: async (a, c) => {
      await c.confirm(await c.call('estimateFixVerify', c.pid(), a.pos));
      return c.call('runFixVerify', c.pid(), a.pos);
    },
  },
  estimateFindingVerify: { name: 'finding verify-estimate', usage: '<finding...>', help: 'Estimate an independent verification of findings', run: (a, c) => c.call('estimateFindingVerify', c.pid(), a.pos) },
  runFindingVerify: {
    name: 'finding verify',
    usage: '<finding...>',
    help: 'Queue a clean session per suspected finding that tries to refute it',
    columns: ['id', 'status', 'title'],
    run: async (a, c) => {
      await c.confirm(await c.call('estimateFindingVerify', c.pid(), a.pos));
      return c.call('runFindingVerify', c.pid(), a.pos);
    },
  },
  enqueuePocSetup: { name: 'poc setup', usage: '', help: 'Queue the setup of the test environment', run: (_a, c) => c.call('enqueuePocSetup', c.pid()) },

  scannerStatus: { name: 'scanner status', usage: '[--refresh]', help: 'Show scanners', columns: ['name', 'enabled', 'available', 'version', 'error'], run: (a, c) => c.call('scannerStatus', c.pid(), a.has('refresh')) },
  runScanners: {
    name: 'scanner run',
    usage: '[--module <name>...] [--repository]',
    help: 'Queue scans at HEAD: of modules (default: all) or of the whole repository',
    run: async (a, c) => c.call('runScanners', c.pid(), { moduleIds: a.has('repository') ? null : await moduleIds(c, a.all('module')) }),
  },
  listScans: { name: 'scanner list', usage: '', help: 'List scans', run: (_a, c) => c.call('listScans', c.pid()) },
  signalsView: { name: 'signal list', usage: '[--commit <sha>]', help: 'Show SAST signals', run: (a, c) => c.call('signalsView', c.pid(), a.one('commit')) },
  signalDetails: { name: 'signal show', usage: '<signal>', help: 'Show a signal', run: (a, c) => c.call('signalDetails', c.pid(), a.pos[0]) },

  listSuppressions: { name: 'suppression list', usage: '', help: 'List suppressions', columns: ['id', 'scope', 'state', 'reason'], run: (_a, c) => c.call('listSuppressions', c.pid()) },
  createSuppression: {
    name: 'suppression create',
    usage: '--scope <scope> --reason <text> [--signal <id>] [--glob <glob>...] [--requirement <id>] [--module <name>] [--expires <date>]',
    help: 'Create a suppression',
    run: async (a, c) => {
      const input: SuppressionInput = {
        scope: oneOf(a.one('scope'), SUPPRESSION_SCOPES, '--scope'),
        reason: required(a, 'reason'),
        signalId: a.one('signal'),
        globs: a.has('glob') ? a.all('glob') : undefined,
        requirementId: a.one('requirement'),
        moduleId: a.has('module') ? await moduleId(c, a.one('module')!) : undefined,
        expiresAt: a.one('expires') ?? null,
      };
      return c.call('createSuppression', c.pid(), input);
    },
  },
  revokeSuppression: { name: 'suppression revoke', usage: '<suppression> <reason>', help: 'Revoke a suppression', run: (a, c) => c.call('revokeSuppression', c.pid(), a.pos[0], a.pos[1]) },
  renewSuppression: { name: 'suppression renew', usage: '<suppression> [--expires <date>]', help: 'Re-confirm a suppression at HEAD', run: (a, c) => c.call('renewSuppression', c.pid(), a.pos[0], a.one('expires') ?? null) },

  scaView: { name: 'sca show', usage: '', help: 'Show modules with their dependencies and SCA items', run: (_a, c) => c.call('scaView', c.pid()) },
  scaItemDetails: { name: 'sca item', usage: '<item>', help: 'Show an SCA item', run: (a, c) => c.call('scaItemDetails', c.pid(), a.pos[0]) },
  addScaInput: {
    name: 'sca add-input',
    usage: '<file> [--module <name>] [--note <text>]',
    help: 'Add a lock file, SBOM or scanner report',
    run: async (a, c) => c.call('addScaInput', c.pid(), c.abs(a.pos[0]), { moduleId: a.has('module') ? await moduleId(c, a.one('module')!) : null, note: a.one('note') ?? '' }),
  },
  removeScaInput: { name: 'sca remove-input', usage: '<input>', help: 'Exclude a dependency file', run: (a, c) => c.call('removeScaInput', c.pid(), a.pos[0]) },
  enqueueScaInventories: { name: 'sca inventory', usage: '[--module <name>...]', help: 'Queue dependency inventories at HEAD', run: async (a, c) => c.call('enqueueScaInventories', c.pid(), a.has('module') ? await moduleIds(c, a.all('module')) : undefined) },
  estimateSca: { name: 'sca estimate', usage: '[--scope <pending|stale>] [--module <name>...] [--item <id>...]', help: 'Estimate an SCA run', run: async (a, c) => c.call('estimateSca', c.pid(), await scaOptions(a, c)) },
  runSca: {
    name: 'sca run',
    usage: '[--scope <pending|stale>] [--module <name>...] [--item <id>...]',
    help: 'Run SCA verdicts',
    run: async (a, c) => {
      const o = await scaOptions(a, c);
      await c.confirm(await c.call('estimateSca', c.pid(), o));
      return c.call('runSca', c.pid(), o);
    },
  },
  setScaVerdict: {
    name: 'sca verdict',
    usage: '<item> <status> <reason> [--evidence <file[:line]>...]',
    help: 'Set a human verdict on an SCA item',
    run: (a, c) => c.call('setScaVerdict', c.pid(), a.pos[0], { status: oneOf(a.pos[1], SCA_STATUSES, 'status'), reason: a.pos[2], evidence: evidence(a) }),
  },
  createScaFinding: { name: 'sca finding', usage: `<item> ${FINDING_FLAGS}`, help: 'Create a finding on an SCA item', run: (a, c) => c.call('createScaFinding', c.pid(), a.pos[0], findingInput(a)) },
  linkScaFinding: { name: 'sca link', usage: '<finding> <item>', help: 'Link a finding to an SCA item', run: (a, c) => c.call('linkScaFinding', c.pid(), a.pos[0], a.pos[1]) },
  scaReportPath: { name: 'sca report', usage: '<report>', help: 'Print the path of a stored report', run: (a, c) => c.call('scaReportPath', c.pid(), a.pos[0]) },

  listBranches: { name: 'diff branches', usage: '', help: 'List branches', run: (_a, c) => c.call('listBranches', c.pid()) },
  estimateDiffCheck: {
    name: 'diff estimate',
    usage: '--base <branch> --head <branch> (--set <id> | --document <id>)',
    help: 'Estimate a branch check',
    run: (a, c) => c.call('estimateDiffCheck', c.pid(), diffInput(a)),
  },
  runDiffCheck: {
    name: 'diff run',
    usage: '--base <branch> --head <branch> (--set <id> | --document <id>)',
    help: 'Check the changes of a branch against a document set or a document',
    run: async (a, c) => {
      const input = diffInput(a);
      await c.confirm(await c.call('estimateDiffCheck', c.pid(), input));
      return c.call('runDiffCheck', c.pid(), input);
    },
  },
  listDiffChecks: { name: 'diff list', usage: '', help: 'List branch checks', columns: ['id', 'headRef', 'baseRef', 'title', 'counts.finding', 'activeJobs'], run: (_a, c) => c.call('listDiffChecks', c.pid()) },
  diffCheckView: { name: 'diff show', usage: '<check>', help: 'Show a branch check', run: (a, c) => c.call('diffCheckView', c.pid(), a.pos[0]) },

  listSchedules: { name: 'schedule list', usage: '', help: 'List schedules', columns: ['id', 'name', 'cron', 'action.kind', 'enabled', 'nextAt', 'lastFiring.outcome'], run: (_a, c) => c.call('listSchedules', c.pid()) },
  scheduleDetails: { name: 'schedule show', usage: '<schedule>', help: 'Show a schedule', run: async (a, c) => c.call('scheduleDetails', c.pid(), await scheduleId(c, a.pos[0])) },
  scheduleHistory: {
    name: 'schedule history',
    usage: '<schedule> [--limit <n>]',
    help: 'List firings of a schedule, newest first',
    columns: ['firedAt', 'trigger', 'outcome', 'reason', 'scheduledAt'],
    run: async (a, c) => c.call('scheduleHistory', c.pid(), await scheduleId(c, a.pos[0]), a.has('limit') ? Number(a.one('limit')) : undefined),
  },
  createSchedule: {
    name: 'schedule add',
    usage: `--name <text> --cron <expr> --action <${SCHEDULE_ACTIONS.join('|')}> ${SCHEDULE_FLAGS}`,
    help: 'Create a schedule; it runs while the app or the service is running, in the time zone of the OS',
    run: async (a, c) => c.call('createSchedule', c.pid(), { name: required(a, 'name'), cron: required(a, 'cron'), action: await scheduleAction(a, c), maxTokens: maxTokens(a) }),
  },
  updateSchedule: {
    name: 'schedule edit',
    usage: `<schedule> [--name <text>] [--cron <expr>] [--action <${SCHEDULE_ACTIONS.join('|')}>] ${SCHEDULE_FLAGS}`,
    help: 'Change a schedule; --action replaces the whole action',
    run: async (a, c) => {
      const patch: Partial<ScheduleInput> = {};
      if (a.has('name')) patch.name = a.one('name');
      if (a.has('cron')) patch.cron = a.one('cron');
      if (a.has('action')) patch.action = await scheduleAction(a, c);
      if (a.has('max-tokens')) patch.maxTokens = maxTokens(a);
      return c.call('updateSchedule', c.pid(), await scheduleId(c, a.pos[0]), patch);
    },
  },
  enableSchedule: { name: 'schedule enable', usage: '<schedule>', help: 'Enable a schedule', run: async (a, c) => c.call('enableSchedule', c.pid(), await scheduleId(c, a.pos[0])) },
  disableSchedule: { name: 'schedule disable', usage: '<schedule>', help: 'Disable a schedule', run: async (a, c) => c.call('disableSchedule', c.pid(), await scheduleId(c, a.pos[0])) },
  removeSchedule: { name: 'schedule remove', usage: '<schedule>', help: 'Remove a schedule; its firings stay in the history', run: async (a, c) => c.call('removeSchedule', c.pid(), await scheduleId(c, a.pos[0])) },
  runSchedule: { name: 'schedule run', usage: '<schedule>', help: 'Fire a schedule now, with the same checks as a planned firing', run: async (a, c) => c.call('runSchedule', c.pid(), await scheduleId(c, a.pos[0])) },
  cronPreview: { name: 'schedule preview', usage: '<cron>', help: 'Show the next times of a cron expression', run: (a, c) => c.call('cronPreview', c.pid(), a.pos[0]) },

  listTerminals: { name: 'terminal list', usage: '', help: 'List output streams', columns: ['id', 'alive', 'runId', 'title'], run: (_a, c) => c.call('listTerminals') },
  terminalSnapshot: { name: 'terminal show', usage: '<terminal>', help: 'Print the scrollback of a stream', run: (a, c) => c.call('terminalSnapshot', a.pos[0]) },
  terminalClose: { name: 'terminal close', usage: '<terminal>', help: 'Close a stream', run: (a, c) => c.call('terminalClose', a.pos[0]) },

  listRoles: { name: 'config roles', usage: '[--global]', help: 'List roles', columns: ['name', 'kind', 'mcp_access', 'title'], run: (_a, c) => c.call('listRoles', c.scope()) },
  defaultTaskRole: { name: 'config default-role', usage: '[--global]', help: 'Print the default role of tasks', run: (_a, c) => c.call('defaultTaskRole', c.scope()) },
  effectiveConfig: {
    name: 'config effective',
    usage: '<role> [--global] [--module <name>] [--matrix <name>] [--item <key>]',
    help: 'Show the effective config of a role with the source of each value',
    run: (a, c) => c.call('effectiveConfig', c.scope(), a.pos[0], a.one('module'), { matrix: a.one('matrix'), item: a.one('item') }),
  },
  taskRole: { name: 'config task-role', usage: '<kind>', help: 'Print the role of a task kind', run: (a, c) => c.call('taskRole', c.pid(), a.pos[0]) },
  listConfigFiles: { name: 'config files', usage: '[--global]', help: 'List config files', columns: ['scope', 'exists', 'path'], run: (_a, c) => c.call('listConfigFiles', c.scope()) },
  readConfigFile: { name: 'config read', usage: '<file> [--global]', help: 'Print a config file', run: (a, c) => c.call('readConfigFile', c.scope(), c.abs(a.pos[0])) },
  writeConfigFile: { name: 'config write', usage: '<file> [--global]', help: 'Replace a config file with stdin', run: async (a, c) => c.call('writeConfigFile', c.scope(), c.abs(a.pos[0]), await a.stdin()) },
};
