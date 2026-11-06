# Concepts

aiegis has no chat of its own. It starts a local coding agent, stores the audit data, prompts and configuration, and the agent reports back through a built-in MCP server.

## Data model

| Entity | What it is | Details |
|---|---|---|
| Project | A git repository registered in the app | [Interface](interface.md#projects) |
| Module | A name plus git globs: the part of the repository one check looks at | [Modules](modules.md) |
| Entry point | A route, handler, queue consumer or other way in, with its authorization and call chain | [Entry points](entry-points.md) |
| Document, version | A standard or guideline; each import is a new version | [Documents](documents.md) |
| Requirement | A reviewed item of an approved document version | [Documents](documents.md) |
| Document set | A group of documents with links to their sources | [Document refresher](document-refresher.md) |
| Matrix, cell | Documents × modules; a cell is one requirement × one module | [Matrix](matrix.md) |
| Finding | A security problem, linked to cells or dependency items | [Findings](findings.md) |
| Signal | A normalized scanner result, given to the agent as a hint | [Signals](signals.md) |
| Suppression | A reasoned decision to hide signals | [Signals](signals.md#suppressions) |
| SCA item | Module × package@version × vulnerability | [SCA](sca.md) |
| Branch check | The changes of a branch against a set or a document | [Branch checks](branch-check.md) |
| Schedule | An action that fires on cron | [Schedules](schedules.md) |
| Job, run | A queue entry, and one execution of it | [Queue and sessions](queue-and-sessions.md) |

## Roles and tasks

A **role** says who an agent session is: its model, effort, instructions and tool permissions. A **task** is a kind of work the app starts by itself: a role, a job title and a prompt template. Both live in the configuration, so you can change them without touching code. See the [list of roles](configuration.md#roles) and the [list of tasks](configuration.md#tasks).

## Background runs and worktrees

Background runs execute on a pinned commit in a separate `git worktree`, kept in the app's data directory. Your working tree is not touched, and uncommitted changes are not seen by those runs.

| Work | Working directory |
|---|---|
| Module markup, entry point maps, matrix, reachability, branch checks, document plans | `worktrees/<sha>` |
| Dependency inventory (build tools write there) | `sca-worktrees/<sha>` |
| PoC tester and env-setup (the instance is built there) | `poc-worktrees/<sha>` |
| Requirement extraction, reading a PDF, document checks | the app's directory for that version or check |
| Free sessions and fix sessions | your working directory |

## The MCP server

The app runs an MCP server on `127.0.0.1` on a random port. Each session gets its own token, and that token fixes the session's project, role and **scope**: the entities it may write. Writes outside the scope are refused. The role field `mcp_access` is `scoped` for background roles and `manage` for the interactive assistant, which can also queue and cancel jobs. See [MCP tools](mcp.md).

## Verdicts need evidence

The app checks what agents write instead of trusting it:

- A `pass` or `finding` verdict needs a reason and code references to files that exist in the run's checkout.
- A `finding` verdict needs a linked finding, and `find_similar` must run before a new finding is created.
- A `pass` that argues from "the scanners found nothing" is refused: the reason must come from the code.
- A requirement's quote must be found in the document text.
- A vulnerable package must appear in a tool report that the run saved.
- A proposed document change must quote a page downloaded in that same run.

## Freshness (`stale`)

Each verdict and map snapshot stores its commit and the files it depends on: its evidence, the module's globs, and the call chains of the module's map. When you view the data, the app compares those against the current `HEAD` with `git diff --name-only`:

- no overlap: the record stays valid;
- overlap: the record is marked `stale`;
- the commit is unreachable: the record is marked `stale`.

A verdict also becomes `stale` when the text of its requirement changes in a new document version. Only commits count, not uncommitted edits, and no AI is called for this. You decide when to recheck.

## History

History is append-only and enforced by database triggers. Each run is a permanent record with its commit, a snapshot of the effective configuration, the session id, the tokens and the cost. The current status of a cell is its latest verdict. A manual edit is one more record with the author `human`, so you can always see who decided what. Authors look like `human`, `auto` (decided by the app without AI) or `ai:<role>`.

## Estimates before spending tokens

Runs that can be large show an estimate first: sessions, items and tokens. The per-item figure comes from the recent successful runs of the role, or from configured defaults when there is no history. The first estimate is therefore approximate. The command line asks for confirmation the same way, and `--yes` skips it.

Generating AI-written documents has no estimate.

## What aiegis does not do

These are out of scope for now: AST slicing, a built-in chat, generating fixes or tests as a separate feature (a fix session is a normal agent session), ZAP, exports to PDF, SARIF or Jira, and threat modeling. An AI-written document is a set of checkable requirements, not a threat model.
