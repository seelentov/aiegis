import { useEffect, useState, type ReactNode } from 'react';
import type { Cell, DocumentSummary, Job, Matrix, ModuleSummary, ProjectInfo, Scan, ScaModuleView, ScannerStatus } from '../../shared/types';
import type { RunFn } from '../App';
import { api } from '../api';
import { tr } from '../i18n';
import { Button, IconButton } from '../ui';
import { Icon } from './Icon';
import { usePersisted } from './Splitter';

type Tab = 'modules' | 'documents' | 'signals' | 'entry-points' | 'matrix' | 'sca' | 'findings';

interface Props {
  project: ProjectInfo | null;
  revision: number;
  run: RunFn;
  /** Set on the first launch: the path then starts with choosing a project. */
  onAddProject?: () => void;
  onOpen: (tab: Tab) => void;
  onCreateMatrix: (documentId: string) => void;
  onTerminal: (id: string | undefined) => void;
  onClose: () => void;
}

interface Data {
  modules: ModuleSummary[];
  markup: Job | null;
  /** Queued or running jobs that plan or write AI documents. */
  writing: boolean;
  documents: DocumentSummary[];
  matrices: Matrix[];
  /** Cells of the first matrix. */
  cells: Cell[];
  scans: Scan[];
  scanners: ScannerStatus[];
  sca: ScaModuleView[];
}

type State = 'done' | 'current' | 'failed' | 'todo' | 'locked';

interface Step {
  id: string;
  title: string;
  optional?: boolean;
  /** Why the step waits; set = locked. */
  needs?: string;
  done?: boolean;
  failed?: boolean;
  /** One line on what is there now. */
  fact?: ReactNode;
  /** Shown on the current step only. */
  why?: string;
  /** Buttons of the current step. */
  actions?: ReactNode;
  /** Buttons beside a step that is not current. */
  side?: ReactNode;
}

const active = (j: Job) => j.status === 'queued' || j.status === 'running';

/** The setup path shown on the first launch: from an empty project to the first audit results. */
export function HomeTab({ project, revision, run, onAddProject, onOpen, onCreateMatrix, onTerminal, onClose }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [skipped, setSkipped] = usePersisted<string[]>('setupSkipped', []);

  useEffect(() => {
    if (!project) return setData(null);
    const id = project.id;
    void run(
      Promise.all([api.listModules(id), api.listJobs(id), api.listDocuments(id), api.listMatrices(id), api.listScans(id), api.scannerStatus(id), api.scaView(id)]),
    ).then(async (r) => {
      if (!r) return;
      const [modules, jobs, documents, matrices, scans, scanners, sca] = r;
      const view = matrices[0] && (await run(api.matrixView(id, matrices[0].id)));
      // Jobs come newest first, as the queue shows them.
      const markup = jobs.find((j) => j.entityType === 'module_map') ?? null;
      const writing = jobs.some((j) => active(j) && (j.entityType === 'doc_plan' || j.entityType === 'doc_gen'));
      setData({ modules, markup, writing, documents: documents.filter((d) => !d.retiredAt), matrices, cells: view ? view.cells : [], scans, scanners, sca: sca.modules });
    });
  }, [project?.id, revision, run]);

  const watch = (j: { lastRunId: string | null } | null) => j?.lastRunId && project && void run(api.openRun(project.id, j.lastRunId)).then(onTerminal);
  const markUp = () => project && void run(api.enqueueModuleMarkup(project.id, ''));
  const upload = async () => {
    if (!project) return;
    const file = await run(api.pickDocumentFile());
    if (file) await run(api.importDocument(project.id, file, {}));
  };
  const open = (tab: Tab) => <Button variant="ghost" onClick={() => onOpen(tab)}>{tr('Open')}</Button>;
  const skip = (id: string) => <Button variant="ghost" onClick={() => setSkipped([...skipped, id])}>{tr('Skip')}</Button>;
  const running = (text: string) => (
    <span className="run">
      <span className="spin"><Icon name="recheck" size={14} /></span>
      {text}
    </span>
  );

  const steps: Step[] = !onAddProject
    ? []
    : [
        project
          ? { id: 'project', title: tr('Choose a project'), done: true, fact: <span className="mono">{project.root}</span> }
          : {
              id: 'project',
              title: tr('Choose a project'),
              why: tr('Pick a git repository on this machine. Every verdict is tied to the commit it was checked on.'),
              actions: <IconButton icon="folderPlus" variant="primary" title={tr('Add git repository')} label={tr('Add project')} onClick={onAddProject} />,
            },
      ];
  const loading = Boolean(project && !data);

  if (!loading) {
    const d = data;
    const modules = d?.modules ?? [];
    const noProject = project ? undefined : tr('Needs a project.');
    const noModules = noProject ?? (modules.length ? undefined : tr('Needs modules.'));

    // Modules
    const markup = d?.markup ?? null;
    if (modules.length) {
      steps.push({ id: 'modules', title: tr('Split into modules'), done: true, fact: tr('Modules: {names}', { names: modules.map((m) => m.name).join(', ') }), side: open('modules') });
    } else if (markup && active(markup)) {
      steps.push({
        id: 'modules',
        title: tr('Split into modules'),
        fact: running(tr('An agent is reading the code.')),
        why: tr('It proposes modules, each a name and the files it owns. You can edit them once it finishes.'),
        actions: <IconButton icon="output" title={tr('Watch output')} label={tr('Watch session')} disabled={!markup.lastRunId} onClick={() => watch(markup)} />,
      });
    } else {
      const failed = markup?.status === 'failed';
      steps.push({
        id: 'modules',
        title: tr('Split into modules'),
        needs: noProject,
        failed,
        fact: failed ? <span className="bad">{markup.error ?? tr('The markup session failed.')}</span> : undefined,
        why: failed
          ? tr('Open the log to see where it stopped, retry, or describe the modules by hand.')
          : tr('An agent reads the code and proposes modules: a name and the files each owns. Hints and manual editing are in Modules.'),
        actions: (
          <>
            <IconButton icon={failed ? 'retry' : 'wand'} variant="primary" title={tr('Mark up modules with AI')} label={failed ? tr('Retry') : tr('Mark up')} onClick={markUp} />
            {failed && markup.lastRunId && <IconButton icon="terminal" title={tr('Open log')} label={tr('Open log')} onClick={() => watch(markup)} />}
            <Button variant="ghost" onClick={() => onOpen('modules')}>{tr('Add by hand')}</Button>
          </>
        ),
      });
    }

    // Scanners: no AI, their signals are hints for the matrix and SCA sessions.
    const scans = d?.scans ?? [];
    const complete = scans.filter((s) => s.status === 'complete');
    const scanning = scans.some((s) => s.status === 'running');
    const ready = (d?.scanners ?? []).filter((s) => s.enabled && s.available).map((s) => s.name);
    steps.push({
      id: 'scanners',
      title: tr('Run the scanners'),
      optional: true,
      needs: noModules,
      done: complete.length > 0 || skipped.includes('scanners'),
      fact: complete.length
        ? tr('Scans: {n}, signals: {k}. Matrix and SCA sessions get them as hints.', { n: complete.length, k: complete.reduce((s, x) => s + x.findingCount, 0) })
        : skipped.includes('scanners')
          ? tr('Skipped.')
          : scanning
            ? running(tr('Scanners are running.'))
            : ready.length
              ? tr('Ready: {names}. No AI involved; their signals become hints for the agents.', { names: ready.join(', ') })
              : tr('No scanners found on this machine. Install Semgrep, Gitleaks or Trivy, or import a SARIF report in Signals.'),
      side: complete.length ? (
        open('signals')
      ) : skipped.includes('scanners') ? null : (
        <>
          <IconButton icon="scan" title={tr('Run the scanners on all modules')} label={tr('Run')} disabled={scanning || !ready.length} onClick={() => project && void run(api.runScanners(project.id, { moduleIds: [] }))} />
          {skip('scanners')}
        </>
      ),
    });

    // Documents
    const documents = d?.documents ?? [];
    const approved = documents.filter((x) => x.current);
    const review = documents.find((x) => x.versions.some((v) => v.status === 'review'));
    const reviewing = review?.versions.find((v) => v.status === 'review');
    // Hints for the writer live in Documents; from here it starts without one.
    const write = (
      <IconButton
        icon="wand"
        title={tr('AI plans documents that cover the whole application, then writes each one; every document goes to review')}
        label={tr('Write with AI')}
        disabled={d?.writing}
        onClick={() => project && void run(api.enqueueDocPlan(project.id, ''))}
      />
    );
    const extracting = documents.some((x) => x.versions.some((v) => v.status === 'extracting'));
    steps.push({
      id: 'documents',
      title: tr('Add security documents'),
      needs: noProject,
      done: approved.length > 0,
      fact: approved.length
        ? tr('Approved documents: {n}. Requirements: {items}', { n: approved.length, items: approved.reduce((s, x) => s + (x.current?.itemCount ?? 0), 0) })
        : reviewing
          ? tr('“{title}” is waiting for review, requirements extracted: {n}.', { title: review!.title, n: reviewing.itemCount })
          : d?.writing
            ? running(tr('An agent is writing security documents.'))
            : extracting
              ? running(tr('Requirements are being extracted.'))
            : tr('No documents yet.'),
      why: tr('The matrix uses approved requirements only. Upload a standard or guideline (MD, PDF, DOCX) or let an agent write one from the code, then review and approve it.'),
      actions: (
        <>
          {reviewing && <IconButton icon="checkAll" variant="primary" title={tr('Review requirements')} label={tr('Review requirements')} onClick={() => onOpen('documents')} />}
          <IconButton icon="upload" variant={reviewing ? undefined : 'primary'} title={tr('Upload document')} label={tr('Upload')} onClick={() => void upload()} />
          {write}
        </>
      ),
      side: approved.length ? (
        open('documents')
      ) : (
        <>
          <IconButton icon="upload" title={tr('Upload document')} label={tr('Upload')} onClick={() => void upload()} />
          {write}
        </>
      ),
    });

    // Entry point maps
    const mapped = modules.filter((m) => m.latestSnapshot?.status === 'complete').length;
    const mapping = modules.some((m) => m.activeJob);
    const mapsSkipped = skipped.includes('maps') && mapped < modules.length;
    steps.push({
      id: 'maps',
      title: tr('Map entry points'),
      optional: true,
      needs: noModules,
      done: mapped === modules.length || mapsSkipped,
      fact: mapsSkipped
        ? tr('Skipped.')
        : mapping
          ? running(tr('Maps are being built: {n} of {total} ready.', { n: mapped, total: modules.length }))
          : tr('Maps: {n} of {total} modules. Matrix sessions use them to follow requests into the code.', { n: mapped, total: modules.length }),
      side:
        mapped === modules.length ? (
          open('entry-points')
        ) : mapsSkipped ? null : (
          <>
            <IconButton icon="route" title={tr('Build entry point maps of all modules')} label={tr('Map all')} disabled={mapping} onClick={() => project && void run(api.enqueueAllEntryPoints(project.id))} />
            {skip('maps')}
          </>
        ),
    });

    // Matrix
    const matrices = d?.matrices ?? [];
    steps.push({
      id: 'matrix',
      title: tr('Create the matrix'),
      needs: noModules ?? (approved.length ? undefined : tr('Needs an approved document.')),
      done: matrices.length > 0,
      fact: matrices.length ? tr('Matrices: {names}', { names: matrices.map((m) => m.name).join(', ') }) : undefined,
      why: tr('Requirements crossed with modules: each cell is one requirement checked in one module.'),
      actions: <IconButton icon="plus" variant="primary" title={tr('Create matrix')} label={tr('Create matrix')} onClick={() => onCreateMatrix(approved[0].id)} />,
      side: open('matrix'),
    });

    const cells = d?.cells ?? [];
    const checked = cells.filter((c) => c.status !== 'not_checked').length;
    const checking = cells.some((c) => c.activeJob);
    steps.push({
      id: 'matrix-run',
      title: tr('Run the matrix'),
      needs: matrices.length ? undefined : tr('Needs a matrix.'),
      done: cells.length > 0 && checked === cells.length,
      fact: checking
        ? running(tr('Checked: {n} of {total} cells.', { n: checked, total: cells.length }))
        : tr('Checked: {n} of {total} cells.', { n: checked, total: cells.length }),
      why: tr('Stage 1 drops requirements that do not apply to a module; stage 2 gives each remaining cell a verdict with evidence. Both show an estimate before anything runs.'),
      actions: <IconButton icon="play" variant="primary" title={tr('Run stages')} label={tr('Run stages')} onClick={() => onOpen('matrix')} />,
      side: open('matrix'),
    });

    // SCA: an inventory per module, then a reachability check per vulnerable package.
    const sca = d?.sca ?? [];
    const inventoried = sca.filter((m) => m.inventory?.status === 'complete').length;
    const pending = sca.reduce((s, m) => s + m.items.filter((i) => i.status === 'not_checked').length, 0);
    const scaRunning = sca.some((m) => m.inventoryJob || m.items.some((i) => i.activeJob));
    const scaFailed = sca.find((m) => m.failedJob)?.failedJob ?? null;
    const needInventory = inventoried < sca.length;
    steps.push({
      id: 'sca',
      title: tr('Check dependencies'),
      needs: noModules,
      done: sca.length > 0 && !needInventory && pending === 0,
      fact: scaRunning ? (
        running(tr('Inventories: {n} of {total} modules.', { n: inventoried, total: sca.length }))
      ) : scaFailed && needInventory ? (
        <span className="bad">{scaFailed.error ?? tr('An inventory session failed.')}</span>
      ) : (
        tr('Inventories: {n} of {total} modules. Vulnerabilities to check: {k}.', { n: inventoried, total: sca.length, k: pending })
      ),
      why: tr('An agent lists the vulnerable dependencies of each module with a scanner, then checks whether the code reaches them.'),
      actions: (
        <>
          {needInventory ? (
            <IconButton icon="package" variant="primary" title={tr('Find vulnerable dependencies')} label={tr('Find dependencies')} disabled={scaRunning} onClick={() => project && void run(api.enqueueScaInventories(project.id))} />
          ) : (
            <IconButton icon="play" variant="primary" title={tr('Check reachability')} label={tr('Check reachability')} onClick={() => onOpen('sca')} />
          )}
          {scaFailed?.lastRunId && <IconButton icon="terminal" title={tr('Open log')} label={tr('Open log')} onClick={() => watch(scaFailed)} />}
        </>
      ),
      side: open('sca'),
    });
  }

  // The first required step that is not done is the current one; optional steps never block the path.
  let current = false;
  const states = steps.map((s): State => {
    if (s.needs) return 'locked';
    if (s.done) return 'done';
    if (s.failed) return (current = true), 'failed';
    if (s.optional || current) return 'todo';
    return (current = true), 'current';
  });
  const doneCount = states.filter((s) => s === 'done').length;
  const finished = !loading && !current;

  return (
    <div className="home">
      <div className="home-head">
        <div>
          <h1>{finished ? tr('The first audit pass is done') : tr('Set up the audit')}</h1>
          <p>{finished ? tr('Results are in Findings.') : tr('From an empty project to the first findings. Steps update as work finishes.')}</p>
        </div>
        {finished ? (
          <IconButton icon="finding" variant="primary" title={tr('Open findings')} label={tr('Open findings')} onClick={() => onOpen('findings')} />
        ) : (
          !loading && <span className="home-count">{tr('{n} of {total} done', { n: doneCount, total: steps.length })}</span>
        )}
      </div>
      <ol className="track" aria-busy={loading || undefined}>
        {steps.map((s, i) => {
          const expanded = states[i] === 'current' || states[i] === 'failed';
          return (
            <li key={s.id} className={`step ${states[i]}`}>
              <span className="mark">{states[i] === 'done' ? <Icon name="check" /> : i + 1}</span>
              <div className="step-body">
                <h2>{s.title}</h2>
                {s.optional && <span className="opt">{tr('optional')}</span>}
                {(s.needs ?? s.fact) && <p className="fact">{s.needs ?? s.fact}</p>}
                {expanded && s.why && <p className="why">{s.why}</p>}
                {expanded && s.actions && <div className="step-actions">{s.actions}</div>}
              </div>
              <span className="step-side">{!expanded && states[i] !== 'locked' && s.side}</span>
            </li>
          );
        })}
        {loading &&
          [0, 1, 2, 3].map((i) => (
            <li key={i} className="step">
              <span className="mark sk" />
              <div className="sk-lines">
                <span className="sk" style={{ width: `${30 - i * 2}%` }} />
                <span className="sk" style={{ width: `${55 - i * 4}%` }} />
              </div>
              <span />
            </li>
          ))}
      </ol>
      <div className="home-foot">
        <span>{tr('Each step opens its own section for the full controls.')}</span>
        <Button variant="ghost" onClick={onClose}>{tr('Close guide')}</Button>
      </div>
    </div>
  );
}
