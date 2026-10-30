import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import {
  ENTRY_POINT_KINDS,
  POC_OUTCOMES,
  SCA_STATUSES,
  SEVERITIES,
  SIGNAL_KINDS,
  VERDICT_STATUSES,
  type CellDetails,
  type Evidence,
  type Finding,
  type Job,
  type MatrixView,
  type QueueState,
  type Run,
  type ScaReport,
} from '../../shared/types';
import type { Settings } from '../config/loader';
import { sha256File } from '../documents';
import { CELL_ENTITY, cellId, DOC_VERSION_ENTITY, quoteFound, rankSimilar, reqHash, type CellRef } from '../matrix';
import { CARRIED_AUTHOR } from '../audit-store';
import { entryPointKey, globsError, matchFiles, MODULE_ENTITY, MODULE_MAP_ENTITY, repoFileError } from '../modules';
import { fileInside, missingInReport, SCA_MODULE_ENTITY, SCA_PACKAGE_ENTITY, scaItemId, scaPackageEntityId, scaTouched } from '../sca';
import { hookDecision, POC_ENTITY } from '../poc';
import type { SignalQuery } from '../signals';
import type { ProjectStore } from '../store';
import { authorize, type Action, type Grant, type TokenRegistry } from './tokens';

export interface McpServices {
  store(projectId: string): ProjectStore;
  projectName(projectId: string): string;
  enqueueTask(projectId: string, t: { prompt: string; role: string; title: string }): Job;
  stopJob(projectId: string, jobId: string): void;
  queueState(): QueueState;
  /** Extracted text of a document version (quote checks); null when claude reads the file itself (PDF). */
  documentText(projectId: string, versionId: string): string | null;
  matrixView(projectId: string, matrixId: string): Promise<MatrixView>;
  cellDetails(projectId: string, cell: CellRef): Promise<CellDetails>;
  /** Queues verdict re-checks of cells (management access). */
  recheckCells(projectId: string, cells: CellRef[]): Promise<Job[]>;
  /** Max candidates of find_similar. */
  similarLimit(projectId: string): number;
  /** Scanner signals of a module for get_signals (suppressed ones are filtered out). */
  signals(projectId: string, q: SignalQuery): Promise<Record<string, unknown>>;
  /** SCA settings of the project (report size limit). */
  scaSettings(projectId: string): Settings['sca'];
  /** Where an inventory report is kept once copied out of the run's checkout. */
  scaReportFile(projectId: string, report: Pick<ScaReport, 'id' | 'path'>): string;
  /** Called after an agent wrote something, so the UI can refresh. */
  onWrite(projectId: string): void;
}

/** find_similar calls of each run: create_finding must present one of their ids (SPEC §4, Q23). */
export type SimilarChecks = Map<string, Set<string>>;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Builds an MCP server instance whose tools are bound to one grant. */
/** "The scanners found nothing" is not evidence for a pass (role prompt); the agent must argue from the code. */
export const NO_SIGNALS_REASON =
  /\b(no|zero|without|absence of)\b[^.;]{0,30}\b(signals?|scanners?|semgrep|gitleaks|trivy)\b|\b(signals?|scanners?|semgrep|gitleaks|trivy)\b[^.;]{0,30}\b(returned|found|reported|showed?)\s+(no|nothing|none)\b/i;

export function buildServer(grant: Grant, svc: McpServices, checks: SimilarChecks = new Map()): McpServer {
  const server = new McpServer({ name: 'aiegis', version: '0.1.0' });
  const pid = grant.projectId;
  const guard = async (action: Action, fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> => {
    const d = authorize(grant, pid, action);
    if (!d.ok) return fail(`Denied: ${d.reason}`);
    try {
      return await fn();
    } catch (e) {
      return fail((e as Error).message);
    }
  };
  const by = { author: `ai:${grant.role}`, runId: grant.runId };
  /** The run of this token; writes that depend on the checkout need it to be alive. */
  const liveRun = (): Run => {
    const run = svc.store(pid).getRun(grant.runId);
    if (!run || run.finishedAt) throw new Error('the run of this token has finished; writing is not allowed');
    return run;
  };

  server.registerTool(
    'whoami',
    { description: 'Who this session is: project, role, access level, session/run ids and the entities it may write.' },
    async () =>
      ok({
        project: { id: pid, name: svc.projectName(pid) },
        role: grant.role,
        access: grant.access,
        session_id: grant.sessionId,
        run_id: grant.runId,
        writable_entities: grant.scope,
      }),
  );

  server.registerTool(
    'list_jobs',
    { description: 'List background jobs of the project with their status, plus the queue state.' },
    async () =>
      guard({ kind: 'read' }, () => ok({ queue: svc.queueState(), jobs: svc.store(pid).listJobs(100) })),
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List recent runs (history) of the project.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) =>
      guard({ kind: 'read' }, () =>
        ok(svc.store(pid).listRuns(limit ?? 50).map(({ configSnapshot: _c, ...r }) => r)),
      ),
  );

  server.registerTool(
    'get_results',
    {
      description: 'Read results written by agents, optionally filtered by entity.',
      inputSchema: { entity_type: z.string().optional(), entity_id: z.string().optional() },
    },
    async ({ entity_type, entity_id }) =>
      guard({ kind: 'read' }, () => ok(svc.store(pid).listResults({ entityType: entity_type, entityId: entity_id }))),
  );

  server.registerTool(
    'submit_result',
    {
      description: 'Write the result for an entity in your scope (see whoami.writable_entities).',
      inputSchema: {
        entity_type: z.string(),
        entity_id: z.string(),
        summary: z.string().min(1),
        details: z.string().optional(),
      },
    },
    async ({ entity_type, entity_id, summary, details }) =>
      guard({ kind: 'write', entity: { type: entity_type, id: entity_id } }, () => {
        const r = svc.store(pid).addResult({
          runId: grant.runId,
          entityType: entity_type,
          entityId: entity_id,
          data: { summary, ...(details ? { details } : {}) },
          author: `ai:${grant.role}`,
        });
        svc.onWrite(pid);
        return ok({ saved: r.id });
      }),
  );

  server.registerTool(
    'list_modules',
    { description: 'Current modules of the project: id, name, globs (git pathspec globs, "!" excludes), description.' },
    async () => guard({ kind: 'read' }, () => ok(svc.store(pid).listModules())),
  );

  server.registerTool(
    'upsert_module',
    {
      description:
        'Create a module or update it (matched by module_id, else by name). Globs are relative to the repository root and must match tracked files. Requires the module_map entity in scope.',
      inputSchema: {
        name: z.string().min(1),
        globs: z.array(z.string().min(1)).min(1),
        description: z.string().min(1),
        module_id: z.string().optional().describe('Existing module to update (allows renaming)'),
      },
    },
    async ({ name, globs, description, module_id }) =>
      guard({ kind: 'write', entity: { type: MODULE_MAP_ENTITY, id: pid } }, async () => {
        const err = globsError(globs);
        if (err) return fail(err);
        const files = await matchFiles(liveRun().cwd, globs);
        if (!files.length) return fail(`globs ${JSON.stringify(globs)} match no repository file`);
        const s = svc.store(pid);
        const id = module_id ?? s.moduleByName(name)?.id;
        const m = s.saveModule({ id, name, globs, description }, by);
        svc.onWrite(pid);
        return ok({ module_id: m.id, name: m.name, matched_files: files.length });
      }),
  );

  server.registerTool(
    'remove_module',
    {
      description: 'Remove a module from the markup (history is kept). Requires the module_map entity in scope.',
      inputSchema: { module_id: z.string(), reason: z.string().min(1) },
    },
    async ({ module_id, reason }) =>
      guard({ kind: 'write', entity: { type: MODULE_MAP_ENTITY, id: pid } }, () => {
        svc.store(pid).removeModule(module_id, reason, by);
        svc.onWrite(pid);
        return ok({ removed: module_id });
      }),
  );

  server.registerTool(
    'get_entry_points',
    {
      description: 'Entry point map of a module: the latest complete snapshot (or the given one) with its entries.',
      inputSchema: { module_id: z.string(), snapshot_id: z.string().optional() },
    },
    async ({ module_id, snapshot_id }) =>
      guard({ kind: 'read' }, () => {
        const s = svc.store(pid);
        const snap = snapshot_id ? s.getSnapshot(snapshot_id) : s.latestSnapshot(module_id);
        if (!snap || snap.moduleId !== module_id) return ok({ snapshot: null, entry_points: [] });
        return ok({ snapshot: snap, entry_points: s.listEntryPoints(snap.id) });
      }),
  );

  const epIdentity = {
    module_id: z.string(),
    kind: z
      .enum(ENTRY_POINT_KINDS)
      .describe('plugin = a method the host platform/framework calls (SPI implementation, listener, hook), not a route of the module itself'),
    method: z.string().optional().describe('HTTP method or similar qualifier'),
    name: z.string().min(1).describe('Route, RPC method, topic, job or command name'),
  };

  server.registerTool(
    'upsert_entry_point',
    {
      description:
        "Record an entry point of your module in this run's map snapshot (same kind+method+name replaces the entry). Requires module:<module_id> in scope.",
      inputSchema: {
        ...epIdentity,
        handler_file: z.string().min(1).describe('Path relative to the repository root'),
        handler_line: z.number().int().min(1),
        middleware: z.array(z.string()).optional().describe('Filters, interceptors, middleware in order'),
        auth: z.string().min(1).describe('Authorization requirements as found in code, or "none found"'),
        params: z
          .array(z.object({ name: z.string(), source: z.string().describe('path|query|header|body|cookie|message|arg|...'), type: z.string().optional() }))
          .optional(),
        call_chain: z
          .array(
            z.object({
              file: z.string(),
              function: z.string(),
              line: z.number().int().min(1).optional(),
              sink: z.string().optional().describe('Kind of sink reached at this step, e.g. SQL, file, exec'),
            }),
          )
          .optional()
          .describe('From the handler to sinks'),
        notes: z.string().optional(),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: { type: MODULE_ENTITY, id: a.module_id } }, () => {
        const run = liveRun();
        const callChain = a.call_chain ?? [];
        for (const f of [a.handler_file, ...callChain.map((c) => c.file)]) {
          const err = repoFileError(run.cwd, f);
          if (err) return fail(err);
        }
        const s = svc.store(pid);
        const snap = s.ensureSnapshot(run, a.module_id);
        const e = s.upsertEntryPoint(snap.id, {
          kind: a.kind,
          method: a.method?.trim() || null,
          name: a.name,
          handler: { file: a.handler_file, line: a.handler_line },
          middleware: a.middleware ?? [],
          auth: a.auth,
          params: a.params ?? [],
          callChain,
          notes: a.notes ?? null,
        });
        svc.onWrite(pid);
        return ok({ saved: e.key, snapshot_id: snap.id, entries_in_snapshot: s.listEntryPoints(snap.id).length });
      }),
  );

  server.registerTool(
    'remove_entry_point',
    {
      description: "Remove an entry point from this run's map snapshot of your module.",
      inputSchema: epIdentity,
    },
    async (a) =>
      guard({ kind: 'write', entity: { type: MODULE_ENTITY, id: a.module_id } }, () => {
        const s = svc.store(pid);
        const snap = s.ensureSnapshot(liveRun(), a.module_id);
        const removed = s.removeEntryPoint(snap.id, entryPointKey({ kind: a.kind, method: a.method ?? null, name: a.name }));
        svc.onWrite(pid);
        return ok({ removed });
      }),
  );

  // --- documents and requirements ---

  server.registerTool(
    'list_documents',
    { description: 'Imported documents (standards, guidelines) with their versions and review status.' },
    async () => guard({ kind: 'read' }, () => ok(svc.store(pid).audit.listDocuments())),
  );

  server.registerTool(
    'get_requirements',
    {
      description:
        'Requirement items of a document version (default: accepted items of the current approved version of document_id).',
      inputSchema: { document_id: z.string().optional(), version_id: z.string().optional() },
    },
    async ({ document_id, version_id }) =>
      guard({ kind: 'read' }, () => {
        const a = svc.store(pid).audit;
        if (version_id) return ok(a.listItems(version_id));
        if (document_id) return ok(a.currentItems([document_id]));
        return fail('specify document_id or version_id');
      }),
  );

  server.registerTool(
    'add_requirement',
    {
      description:
        'Record one requirement extracted from your document version (same key replaces the item). The quote must be copied verbatim from the document. Requires doc_version:<version_id> in scope.',
      inputSchema: {
        version_id: z.string(),
        key: z.string().optional().describe('Id used in the document; omit to let aiegis generate one'),
        text: z.string().min(1).describe('The requirement, self-contained, one or two sentences'),
        section: z.string().describe('Section or group heading of the document'),
        quote: z.string().min(1).describe('Exact source sentence(s) from the document'),
      },
    },
    async ({ version_id, key, text, section, quote }) =>
      guard({ kind: 'write', entity: { type: DOC_VERSION_ENTITY, id: version_id } }, () => {
        liveRun();
        const a = svc.store(pid).audit;
        const v = a.getVersion(version_id);
        if (!v) return fail(`version ${version_id} not found`);
        if (v.status === 'approved') return fail('the version is already approved; changes are not possible');
        const doc = svc.documentText(pid, version_id);
        if (doc !== null && !quoteFound(doc, quote)) return fail('the quote is not in the document text: copy the sentence verbatim');
        // Unchanged wording is carried over from the previous version; re-extracting it would re-split or duplicate it.
        const carried = a
          .listItems(version_id)
          .find((i) => i.author === CARRIED_AUTHOR && (i.key === key?.trim() || quoteFound(i.quote, quote) || quoteFound(quote, i.quote)));
        if (carried) return fail(`item ${carried.key} was carried over from the previous version unchanged: do not extract this text again`);
        const item = a.upsertItem(version_id, { key, text, section, quote }, by);
        svc.onWrite(pid);
        return ok({ saved: item.key, requirement_id: item.requirementId, items_in_version: a.listItems(version_id).length });
      }),
  );

  // --- matrix ---

  const cellArgs = { module_id: z.string(), requirement_id: z.string() };
  const cellOf = (a: { module_id: string; requirement_id: string }): CellRef => ({ moduleId: a.module_id, requirementId: a.requirement_id });
  const cellEntity = (c: CellRef) => ({ type: CELL_ENTITY, id: cellId(c) });
  const evidenceSchema = z.array(
    z.object({ file: z.string().min(1).describe('Path relative to the repository root'), line: z.number().int().min(1).optional(), note: z.string().optional() }),
  );
  /** Current requirement item and module of a cell; throws if either is gone. */
  const cellTarget = (c: CellRef) => {
    const s = svc.store(pid);
    const item = s.audit.currentItem(c.requirementId);
    if (!item) throw new Error(`requirement ${c.requirementId} not found among approved ones`);
    const mod = s.getModule(c.moduleId);
    if (!mod) throw new Error(`module ${c.moduleId} not found`);
    return { item, mod };
  };
  const checkFiles = (cwd: string, files: Evidence[]) => {
    for (const f of files) {
      const err = repoFileError(cwd, f.file);
      if (err) throw new Error(err);
    }
  };

  server.registerTool(
    'list_matrices',
    { description: 'Requirement matrices of the project (documents x modules).' },
    async () => guard({ kind: 'read' }, () => ok(svc.store(pid).audit.listMatrices())),
  );

  server.registerTool(
    'get_matrix',
    {
      description: 'Cells of a matrix: status (not_checked | n/a | pass | finding | needs_human), stale flag, finding count.',
      inputSchema: { matrix_id: z.string() },
    },
    async ({ matrix_id }) =>
      guard({ kind: 'read' }, async () => {
        const v = await svc.matrixView(pid, matrix_id);
        return ok({
          matrix: v.matrix,
          head: v.head,
          modules: v.modules.map((m) => ({ id: m.id, name: m.name })),
          requirements: v.requirements.map((r) => ({ requirement_id: r.requirementId, key: r.key, section: r.section, text: r.text })),
          cells: v.cells.map((c) => ({
            module_id: c.moduleId,
            requirement_id: c.requirementId,
            status: c.status,
            stale: c.stale,
            findings: c.findingCount,
          })),
        });
      }),
  );

  server.registerTool(
    'get_cell',
    { description: 'One matrix cell: requirement, verdict history, triage, linked findings.', inputSchema: cellArgs },
    async (a) =>
      guard({ kind: 'read' }, async () => {
        const { config: _c, ...d } = await svc.cellDetails(pid, cellOf(a));
        return ok({ ...d, verdicts: d.verdicts.map(({ run: _r, ...v }) => v) });
      }),
  );

  server.registerTool(
    'triage_cell',
    {
      description:
        'Applicability triage of a cell in your scope: applicable=false marks it n/a with the reason; applicable=true leaves it for the verdict stage.',
      inputSchema: { ...cellArgs, applicable: z.boolean(), reason: z.string().min(1) },
    },
    async (a) =>
      guard({ kind: 'write', entity: cellEntity(cellOf(a)) }, () => {
        const run = liveRun();
        const c = cellOf(a);
        const { item, mod } = cellTarget(c);
        const audit = svc.store(pid).audit;
        const hash = reqHash(item.text);
        audit.addTriage({ ...c, reqHash: hash, applicable: a.applicable, reason: a.reason }, by);
        if (!a.applicable) {
          audit.addVerdict(
            { ...c, itemId: item.id, reqHash: hash, status: 'n/a', reason: a.reason, evidence: [], commitSha: run.commitSha, touchedFiles: [], moduleGlobs: mod.globs },
            by,
          );
        }
        svc.onWrite(pid);
        return ok({ cell: cellId(c), status: a.applicable ? 'not_checked' : 'n/a' });
      }),
  );

  server.registerTool(
    'set_verdict',
    {
      description:
        'Verdict for a cell in your scope. pass/finding need evidence (code references) and a reason; finding needs a linked finding (create_finding or link_finding first); n/a and needs_human need a reason.',
      inputSchema: {
        ...cellArgs,
        status: z.enum(VERDICT_STATUSES),
        reason: z.string().min(1).describe('Justification'),
        evidence: evidenceSchema.optional(),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: cellEntity(cellOf(a)) }, () => {
        const run = liveRun();
        const c = cellOf(a);
        const { item, mod } = cellTarget(c);
        const s = svc.store(pid);
        const evidence = a.evidence ?? [];
        if ((a.status === 'pass' || a.status === 'finding') && !evidence.length) return fail('pass/finding requires code references (evidence)');
        if (a.status === 'pass' && NO_SIGNALS_REASON.test(a.reason))
          return fail('pass cannot rest on the absence of scanner signals: describe what in the code satisfies the requirement');
        checkFiles(run.cwd, evidence);
        const findings = s.audit.findingsOfCell(c);
        if (a.status === 'finding' && !findings.length)
          return fail('record the finding first: find_similar, then create_finding or link_finding for this cell');
        const touched = new Set([
          ...evidence.map((e) => e.file),
          ...(a.status === 'finding' ? findings.flatMap((f) => f.files.map((x) => x.file)) : []),
          ...(s.latestSnapshot(mod.id)?.touchedFiles ?? []),
        ]);
        const v = s.audit.addVerdict(
          {
            ...c,
            itemId: item.id,
            reqHash: reqHash(item.text),
            status: a.status,
            reason: a.reason,
            evidence,
            commitSha: run.commitSha,
            touchedFiles: [...touched].sort(),
            moduleGlobs: mod.globs,
          },
          by,
        );
        svc.onWrite(pid);
        return ok({ saved: v.id, cell: cellId(c), status: v.status });
      }),
  );

  // --- findings ---

  const findingView = (f: Finding) => ({
    finding_id: f.id,
    title: f.title,
    status: f.status,
    severity: f.severity,
    cwe: f.cwe,
    module_id: f.moduleId,
    entry_point: f.entryPoint,
    files: f.files,
    cells: f.cells,
    sca_items: f.scaItems,
    description: f.description,
  });

  server.registerTool(
    'list_findings',
    {
      description: 'Findings of the project (merged ones are omitted).',
      inputSchema: { status: z.string().optional(), module_id: z.string().optional() },
    },
    async ({ status, module_id }) =>
      guard({ kind: 'read' }, () =>
        ok(
          svc
            .store(pid)
            .audit.listFindings()
            .filter((f) => !f.mergedInto && (!status || f.status === status) && (!module_id || f.moduleId === module_id))
            .map(findingView),
        ),
      ),
  );

  server.registerTool(
    'find_similar',
    {
      description:
        'Deduplication check, mandatory before create_finding: existing findings with the same entry point, CWE or files. Returns a check_id for create_finding.',
      inputSchema: {
        module_id: z.string().optional(),
        entry_point: z.string().optional().describe('Entry point key as in the map, e.g. "http POST /login"'),
        files: z.array(z.string()).describe('Files of the flaw, relative to the repository root'),
        cwe: z.string().optional().describe('e.g. CWE-639'),
      },
    },
    async (a) =>
      guard({ kind: 'read' }, () => {
        const s = svc.store(pid);
        const similar = rankSimilar(
          { moduleId: a.module_id ?? null, entryPoint: a.entry_point ?? null, cwe: a.cwe ?? null, files: a.files.map((file) => ({ file })) },
          s.audit.listFindings(),
          svc.similarLimit(pid),
        );
        const checkId = crypto.randomUUID();
        const set = checks.get(grant.runId) ?? new Set<string>();
        set.add(checkId);
        checks.set(grant.runId, set);
        return ok({ check_id: checkId, candidates: similar.map((x) => ({ ...findingView(x.finding), score: x.score, reasons: x.reasons })) });
      }),
  );

  server.registerTool(
    'create_finding',
    {
      description:
        'Create a finding (status suspected) linked to a cell in your scope. Call find_similar first and pass its check_id; if a candidate is the same flaw, use link_finding instead.',
      inputSchema: {
        ...cellArgs,
        check_id: z.string().describe('check_id returned by find_similar in this run'),
        title: z.string().min(1),
        description: z.string().min(1).describe('What is wrong, how it can be exploited, impact'),
        severity: z.enum(SEVERITIES),
        cwe: z.string().optional(),
        entry_point: z.string().optional().describe('Entry point key, if reachable through one'),
        files: evidenceSchema.min(1),
        recommendation: z.string().optional(),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: cellEntity(cellOf(a)) }, () => {
        const run = liveRun();
        if (!checks.get(grant.runId)?.has(a.check_id)) return fail('no such check_id: call find_similar in this run first');
        const c = cellOf(a);
        cellTarget(c);
        checkFiles(run.cwd, a.files);
        const f = svc.store(pid).audit.createFinding(
          {
            title: a.title.trim(),
            description: a.description,
            severity: a.severity,
            cwe: a.cwe?.trim() || null,
            moduleId: c.moduleId,
            entryPoint: a.entry_point?.trim() || null,
            files: a.files,
            recommendation: a.recommendation ?? null,
          },
          [c],
          by,
        );
        svc.onWrite(pid);
        return ok({ finding_id: f.id, status: f.status });
      }),
  );

  server.registerTool(
    'link_finding',
    {
      description: 'Link an existing finding (e.g. a find_similar candidate) to a cell in your scope.',
      inputSchema: { ...cellArgs, finding_id: z.string() },
    },
    async (a) =>
      guard({ kind: 'write', entity: cellEntity(cellOf(a)) }, () => {
        liveRun();
        const c = cellOf(a);
        cellTarget(c);
        const f = svc.store(pid).audit.linkFinding(a.finding_id, c, by);
        svc.onWrite(pid);
        return ok({ finding_id: f.id, cells: f.cells.length });
      }),
  );

  // --- scanner signals ---

  server.registerTool(
    'get_signals',
    {
      description:
        "Scanner signals (Semgrep, Gitleaks, Trivy, normalized) in a module's files, from scans at your run's commit (or the newest scanned one); signals suppressed by humans are filtered out. Hints to verify, not a complete list.",
      inputSchema: {
        module_id: z.string(),
        requirement_id: z.string().optional().describe('The requirement you are checking: applies its suppressions and configured relevance'),
        kind: z.enum(SIGNAL_KINDS).optional(),
        scanner: z.string().optional(),
        min_severity: z.enum(SEVERITIES).optional(),
        file_prefix: z.string().optional().describe('Only files under this path (relative to the repository root)'),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (a) =>
      guard({ kind: 'read' }, async () =>
        ok(
          await svc.signals(pid, {
            moduleId: a.module_id,
            requirementId: a.requirement_id ?? null,
            commit: svc.store(pid).getRun(grant.runId)?.commitSha ?? null,
            kind: a.kind ?? null,
            scanner: a.scanner ?? null,
            minSeverity: a.min_severity ?? null,
            filePrefix: a.file_prefix ?? null,
            limit: a.limit ?? null,
          }),
        ),
      ),
  );

  // --- SCA ---

  const scaVulnSchema = z.object({
    id: z.string().min(1).describe('CVE, GHSA or OSV id exactly as in the report'),
    aliases: z.array(z.string()).optional().describe('Other ids of the same vulnerability listed in the report'),
    severity: z.enum(SEVERITIES).describe('Severity from the report (UNKNOWN -> info)'),
    title: z.string().optional().describe('Short description from the report'),
    fixed_version: z.string().optional(),
  });
  /** Package of the module's current inventory, or throws. */
  const currentPackage = (moduleId: string, key: string) => {
    const s = svc.store(pid);
    const mod = s.getModule(moduleId);
    if (!mod) throw new Error(`module ${moduleId} not found`);
    const inv = s.sca.latestInventory(moduleId);
    const pkg = inv && s.sca.listPackages(inv.id).find((p) => p.key === key);
    if (!pkg) throw new Error(`package ${key} is not in the current module inventory`);
    return { mod, pkg };
  };
  const scaRef = (moduleId: string, key: string, vulnId: string) => ({ moduleId, packageKey: key, vulnId });
  const checkVulns = (pkg: { key: string; vulns: { vulnId: string }[] }, ids: string[]) => {
    const bad = ids.filter((v) => !pkg.vulns.some((x) => x.vulnId === v));
    if (bad.length) throw new Error(`package ${pkg.key} has no vulnerabilities: ${bad.join(', ')}`);
  };

  server.registerTool(
    'get_sca_inventory',
    {
      description: "Dependency inventory of a module: vulnerable packages and their vulnerabilities with reachability status. Default: the module's current inventory.",
      inputSchema: { module_id: z.string() },
    },
    async ({ module_id }) =>
      guard({ kind: 'read' }, () => {
        const s = svc.store(pid);
        const own = s.sca.inventoryOf(grant.runId, module_id);
        const inv = own ?? s.sca.latestInventory(module_id);
        if (!inv) return ok({ inventory: null, packages: [] });
        const verdicts = s.sca.latestVerdicts();
        return ok({
          inventory: { id: inv.id, status: inv.status, commit_sha: inv.commitSha, summary: inv.summary },
          packages: s.sca.listPackages(inv.id).map((p) => ({
            package_key: p.key,
            ecosystem: p.ecosystem,
            name: p.name,
            version: p.version,
            direct: p.direct,
            manifest: p.manifest,
            import_names: p.importNames,
            vulnerabilities: p.vulns.map((v) => ({
              id: v.vulnId,
              severity: v.severity,
              title: v.title,
              fixed_version: v.fixedVersion,
              status: verdicts.get(scaItemId(scaRef(module_id, p.key, v.vulnId)))?.status ?? 'not_checked',
            })),
          })),
        });
      }),
  );

  server.registerTool(
    'add_vulnerable_package',
    {
      description:
        "Record a vulnerable package@version in this run's inventory of your module (same ecosystem+name+version replaces it). Every vulnerability must be listed in `report`, a tool report you wrote inside the run directory. Requires sca_module:<module_id> in scope.",
      inputSchema: {
        module_id: z.string(),
        report: z.string().min(1).describe('Path of the tool report (JSON or text) relative to the current directory'),
        ecosystem: z.string().min(1).describe('maven, npm, pypi, go, cargo, nuget, ...'),
        name: z.string().min(1).describe('Package name as in the report, e.g. "com.fasterxml.jackson.core:jackson-databind"'),
        version: z.string().min(1).describe('Resolved version'),
        direct: z.boolean().optional().describe('Declared by the module itself (false = transitive)'),
        manifest: z.string().optional().describe('Build/lock file that brings the package in, relative to the repository root'),
        import_names: z
          .array(z.string().min(1))
          .describe('How code refers to the package: Java top-level packages of its classes, npm package name, Python module names. Empty if unknown.'),
        purl: z.string().optional(),
        vulnerabilities: z.array(scaVulnSchema).min(1),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: { type: SCA_MODULE_ENTITY, id: a.module_id } }, () => {
        const run = liveRun();
        const s = svc.store(pid);
        const mod = s.getModule(a.module_id);
        if (!mod) return fail(`module ${a.module_id} not found`);
        const abs = fileInside(run.cwd, a.report);
        if (!abs) return fail(`report ${a.report} not found: specify a file path inside the current directory`);
        const size = fs.statSync(abs).size;
        if (size > svc.scaSettings(pid).report_max_mb * 1024 * 1024) return fail(`report ${a.report} exceeds sca.report_max_mb: narrow the scan`);
        if (a.manifest) {
          const err = repoFileError(run.cwd, a.manifest);
          if (err) return fail(err);
        }
        const text = fs.readFileSync(abs, 'utf8');
        const miss = missingInReport(text, { name: a.name }, a.vulnerabilities);
        if (miss.package || !text.includes(a.version)) return fail(`report ${a.report} has no package ${a.name} version ${a.version}`);
        if (miss.vulns.length) return fail(`report ${a.report} has no vulnerabilities: ${miss.vulns.join(', ')}; record only what the tool found`);
        const inv = s.sca.ensureInventory(run, mod);
        const rep = s.sca.addReport(inv.id, { path: a.report, sha256: sha256File(abs), size });
        const dst = svc.scaReportFile(pid, rep);
        if (!fs.existsSync(dst)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(abs, dst);
        }
        const p = s.sca.upsertPackage(
          inv.id,
          {
            ecosystem: a.ecosystem,
            name: a.name,
            version: a.version,
            direct: a.direct ?? null,
            importNames: a.import_names.map((n) => n.trim()).filter(Boolean),
            manifest: a.manifest?.trim() || null,
            purl: a.purl?.trim() || null,
            vulns: a.vulnerabilities.map((v) => ({
              id: v.id.trim(),
              aliases: v.aliases ?? [],
              severity: v.severity,
              title: v.title?.trim() || null,
              fixedVersion: v.fixed_version?.trim() || null,
            })),
          },
          () => rep.id,
        );
        svc.onWrite(pid);
        return ok({ saved: p.key, vulnerabilities: p.vulns.length, packages_in_inventory: s.sca.listPackages(inv.id).length });
      }),
  );

  server.registerTool(
    'remove_vulnerable_package',
    {
      description: "Remove a package from this run's inventory of your module (e.g. recorded by mistake).",
      inputSchema: { module_id: z.string(), package_key: z.string().describe('"<ecosystem>:<name>@<version>" as returned by add_vulnerable_package') },
    },
    async (a) =>
      guard({ kind: 'write', entity: { type: SCA_MODULE_ENTITY, id: a.module_id } }, () => {
        const run = liveRun();
        const s = svc.store(pid);
        const mod = s.getModule(a.module_id);
        if (!mod) return fail(`module ${a.module_id} not found`);
        const removed = s.sca.removePackage(s.sca.ensureInventory(run, mod).id, a.package_key);
        svc.onWrite(pid);
        return ok({ removed });
      }),
  );

  server.registerTool(
    'set_inventory_summary',
    {
      description:
        "Finish this run's inventory of your module (mandatory, also when nothing vulnerable was found): ecosystems, tools used, number of resolved dependencies checked, manifests the result depends on.",
      inputSchema: {
        module_id: z.string(),
        ecosystems: z.array(z.string().min(1)),
        tools: z.array(z.string().min(1)).min(1).describe('Tools used to resolve dependencies and to look up vulnerabilities'),
        dependencies_total: z.number().int().min(0).describe('Resolved dependencies checked, vulnerable or not'),
        manifests: z.array(z.string().min(1)).describe('Build and lock files of the repository the inventory depends on, relative to the repository root'),
        notes: z.string().optional().describe('What could not be resolved, assumptions'),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: { type: SCA_MODULE_ENTITY, id: a.module_id } }, () => {
        const run = liveRun();
        const s = svc.store(pid);
        const mod = s.getModule(a.module_id);
        if (!mod) return fail(`module ${a.module_id} not found`);
        // Generated lock files are not tracked: only manifests of the commit make the inventory stale (SPEC §5).
        const manifests = [...new Set(a.manifests.map((m) => m.trim()))];
        const bad = manifests.filter((m) => repoFileError(run.cwd, m));
        if (bad.length) return fail(`files not found: ${bad.join(', ')}`);
        const tracked = new Set(execFileSync('git', ['ls-files', '--', ...manifests], { cwd: run.cwd, encoding: 'utf8' }).split('\n'));
        const generated = manifests.filter((m) => !tracked.has(m));
        if (generated.length) return fail(`not tracked by git (generated?): ${generated.join(', ')}; specify repository files only`);
        const inv = s.sca.ensureInventory(run, mod);
        s.sca.setSummary(inv.id, { ecosystems: a.ecosystems, tools: a.tools, dependenciesTotal: a.dependencies_total, manifests, notes: a.notes?.trim() || null });
        svc.onWrite(pid);
        return ok({ inventory_id: inv.id, vulnerable_packages: s.sca.listPackages(inv.id).length });
      }),
  );

  const scaPkgArgs = {
    module_id: z.string(),
    package_key: z.string().describe('"<ecosystem>:<name>@<version>"'),
  };
  const scaPkgEntity = (a: { module_id: string; package_key: string }) => ({ type: SCA_PACKAGE_ENTITY, id: scaPackageEntityId(a.module_id, a.package_key) });

  server.registerTool(
    'set_sca_verdict',
    {
      description:
        'Reachability verdict for one vulnerability of the package in your scope. reachable needs evidence and a linked finding (create_sca_finding or link_sca_finding first); not_reachable needs evidence of how the package is used; needs_human needs a reason.',
      inputSchema: {
        ...scaPkgArgs,
        vuln_id: z.string(),
        status: z.enum(SCA_STATUSES),
        reason: z.string().min(1).describe('Justification'),
        evidence: evidenceSchema.optional(),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: scaPkgEntity(a) }, () => {
        const run = liveRun();
        const { mod, pkg } = currentPackage(a.module_id, a.package_key);
        checkVulns(pkg, [a.vuln_id]);
        const s = svc.store(pid);
        const evidence = a.evidence ?? [];
        if (a.status !== 'needs_human' && !evidence.length) return fail('reachable/not_reachable requires code references (evidence)');
        checkFiles(run.cwd, evidence);
        const ref = scaRef(a.module_id, pkg.key, a.vuln_id);
        const findings = s.audit.findingsOfScaItem(ref);
        if (a.status === 'reachable' && !findings.length)
          return fail('record the finding first: find_similar, then create_sca_finding or link_sca_finding');
        const v = s.sca.addVerdict(
          {
            ...ref,
            status: a.status,
            reason: a.reason,
            evidence,
            commitSha: run.commitSha,
            touchedFiles: scaTouched(evidence, pkg, a.status === 'reachable' ? findings : []),
            moduleGlobs: mod.globs,
          },
          by,
        );
        svc.onWrite(pid);
        return ok({ saved: v.id, vuln_id: v.vulnId, status: v.status });
      }),
  );

  server.registerTool(
    'create_sca_finding',
    {
      description:
        'Create a finding (status suspected) for reachable vulnerabilities of the package in your scope. Call find_similar first and pass its check_id; if a candidate is the same flaw, use link_sca_finding instead.',
      inputSchema: {
        ...scaPkgArgs,
        vuln_ids: z.array(z.string()).min(1).describe('Vulnerabilities of the package this finding covers'),
        check_id: z.string().describe('check_id returned by find_similar in this run'),
        title: z.string().min(1),
        description: z.string().min(1).describe('Which vulnerable part is used, how an attacker reaches it, impact'),
        severity: z.enum(SEVERITIES),
        cwe: z.string().optional(),
        entry_point: z.string().optional().describe('Entry point key, if reachable through one'),
        files: evidenceSchema.min(1),
        recommendation: z.string().optional().describe('e.g. upgrade to the fixed version'),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: scaPkgEntity(a) }, () => {
        const run = liveRun();
        if (!checks.get(grant.runId)?.has(a.check_id)) return fail('no such check_id: call find_similar in this run first');
        const { pkg } = currentPackage(a.module_id, a.package_key);
        checkVulns(pkg, a.vuln_ids);
        checkFiles(run.cwd, a.files);
        const f = svc.store(pid).audit.createFinding(
          {
            title: a.title.trim(),
            description: a.description,
            severity: a.severity,
            cwe: a.cwe?.trim() || null,
            moduleId: a.module_id,
            entryPoint: a.entry_point?.trim() || null,
            files: a.files,
            recommendation: a.recommendation ?? null,
          },
          [],
          by,
          a.vuln_ids.map((v) => scaRef(a.module_id, pkg.key, v)),
        );
        svc.onWrite(pid);
        return ok({ finding_id: f.id, status: f.status });
      }),
  );

  server.registerTool(
    'link_sca_finding',
    {
      description: 'Link an existing finding (e.g. a find_similar candidate) to vulnerabilities of the package in your scope.',
      inputSchema: { ...scaPkgArgs, vuln_ids: z.array(z.string()).min(1), finding_id: z.string() },
    },
    async (a) =>
      guard({ kind: 'write', entity: scaPkgEntity(a) }, () => {
        liveRun();
        const { pkg } = currentPackage(a.module_id, a.package_key);
        checkVulns(pkg, a.vuln_ids);
        const audit = svc.store(pid).audit;
        let f = audit.getFinding(a.finding_id);
        for (const v of a.vuln_ids) f = audit.linkScaFinding(a.finding_id, scaRef(a.module_id, pkg.key, v), by);
        svc.onWrite(pid);
        return ok({ finding_id: f!.id, sca_items: f!.scaItems.length });
      }),
  );

  server.registerTool(
    'set_poc_result',
    {
      description:
        'Result of the PoC test of the finding in your scope (poc:<finding_id>): reproduced / not_reproduced need the steps you ran with the responses you observed; inconclusive needs a summary of what is missing. Does not change the finding status.',
      inputSchema: {
        finding_id: z.string(),
        outcome: z.enum(POC_OUTCOMES),
        summary: z.string().min(1),
        steps: z
          .array(
            z.object({
              action: z.string().min(1).describe('Request or command that was run (no secret values)'),
              result: z.string().min(1).describe('Excerpt of the response: status and the relevant part of the body'),
              note: z.string().optional(),
            }),
          )
          .optional(),
      },
    },
    async (a) =>
      guard({ kind: 'write', entity: { type: POC_ENTITY, id: a.finding_id } }, () => {
        const run = liveRun();
        if (!grant.baseUrl) return fail('the run has no test environment');
        const steps = a.steps ?? [];
        if (a.outcome !== 'inconclusive' && !steps.length) return fail('reproduced/not_reproduced requires steps with observed responses (steps)');
        const s = svc.store(pid);
        if (!s.audit.getFinding(a.finding_id)) return fail(`finding ${a.finding_id} not found`);
        const r = s.audit.addPocResult(
          { findingId: a.finding_id, outcome: a.outcome, summary: a.summary, steps, baseUrl: grant.baseUrl, commitSha: run.commitSha },
          by,
        );
        svc.onWrite(pid);
        return ok({ saved: r.id, outcome: r.outcome });
      }),
  );

  server.registerTool(
    'recheck_cells',
    {
      description: 'Queue verdict re-checks of matrix cells (requires management access); a dry-run estimate is not shown here.',
      inputSchema: { cells: z.array(z.object(cellArgs)).min(1) },
    },
    async ({ cells }) =>
      guard({ kind: 'manage' }, async () => {
        const jobs = await svc.recheckCells(pid, cells.map(cellOf));
        return ok(jobs.map((j) => ({ job_id: j.id, title: j.title, cells: (j.payload.cells as string[]).length })));
      }),
  );

  server.registerTool(
    'enqueue_task',
    {
      description: 'Queue a background agent task in this project (requires management access).',
      inputSchema: {
        prompt: z.string().min(1),
        role: z.string().optional().describe('Background role, default "task"'),
        title: z.string().optional(),
      },
    },
    async ({ prompt, role, title }) =>
      guard({ kind: 'manage' }, () => {
        const job = svc.enqueueTask(pid, { prompt, role: role ?? 'task', title: title ?? prompt.slice(0, 80) });
        return ok({ job_id: job.id, status: job.status });
      }),
  );

  server.registerTool(
    'cancel_job',
    { description: 'Cancel a queued or running job (requires management access).', inputSchema: { job_id: z.string() } },
    async ({ job_id }) =>
      guard({ kind: 'manage' }, () => {
        svc.stopJob(pid, job_id);
        return ok({ cancelled: job_id });
      }),
  );

  return server;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** HTTP MCP server on 127.0.0.1:<random>; each request is authenticated by its run token. */
export class AiegisMcpServer {
  private server: http.Server | null = null;
  private readonly checks: SimilarChecks = new Map();
  port = 0;

  constructor(
    private readonly tokens: TokenRegistry,
    private readonly svc: McpServices,
  ) {}

  /** Drops per-run state once the run's token is revoked. */
  forgetRun(runId: string): void {
    this.checks.delete(runId);
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** PreToolUse HTTP hook of tester sessions. */
  hookUrl(): string {
    return `http://127.0.0.1:${this.port}${HOOK_PATH}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url === HOOK_PATH) return this.handleHook(req, res);
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const grant = this.tokens.fromHeader(req.headers.authorization);
    if (!grant) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid token' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const body = await readBody(req);
    const server = buildServer(grant, this.svc, this.checks);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** Hook verdict for a tool call of a tester session; a revoked or unknown token blocks (onFailure: block). */
  private async handleHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const grant = this.tokens.fromHeader(req.headers.authorization);
    if (!grant?.baseUrl || req.method !== 'POST') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid token' }));
      return;
    }
    const reason = hookDecision(grant.baseUrl, ((await readBody(req)) ?? {}) as Parameters<typeof hookDecision>[1]);
    const out = reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  }
}

const HOOK_PATH = '/hooks/pre-tool-use';

/** Content of the --mcp-config file handed to claude. */
export function mcpConfigJson(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: { aiegis: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
  });
}
