# Concepts

aiegis has no chat. It starts a local coding agent, stores audit data, prompts and configuration, and receives the agent's results through a built-in MCP server.

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
| Finding | A security problem, linked to cells or dependency items, or found by a [vulnerability hunt](modules.md#vulnerability-hunt) | [Findings](findings.md) |
| Signal | A normalized scanner result, given to the agent as a hint | [Signals](signals.md) |
| Suppression | A reasoned decision to hide signals | [Signals](signals.md#suppressions) |
| SCA item | Module × package@version × vulnerability | [SCA](sca.md) |
| Branch check | The changes of a branch against a set or a document | [Branch checks](branch-check.md) |
| Schedule | An action that fires on cron | [Schedules](schedules.md) |
| Job, run | A queue entry, and one execution of it | [Queue and sessions](queue-and-sessions.md) |

## Roles and tasks

A role defines an agent session: model, effort, instructions, tool permissions. A task is a kind of work the app starts on its own: a role, a job title and a prompt template. Both are configuration files, not code. See the [list of roles](configuration.md#roles) and the [list of tasks](configuration.md#tasks).

## Background runs and worktrees

Background runs execute on a pinned commit in a separate `git worktree` under the app's data directory. They don't touch the working tree and don't see uncommitted changes.

| Work | Working directory |
|---|---|
| Module markup, entry point maps, matrix, reachability, branch checks, document plans | `worktrees/<sha>` |
| Dependency inventory (build tools write there) | `sca-worktrees/<sha>` |
| PoC tester and env-setup (the instance is built there) | `poc-worktrees/<sha>` |
| Requirement extraction, reading a PDF, document checks | the app's directory for that version or check |
| Free sessions and fix sessions | your working directory |

## The MCP server

The app runs an MCP server on `127.0.0.1` on a random port. Each session gets its own token, bound to a project, a role and a scope: the entities the session may write. The server refuses writes outside the scope. The role field `mcp_access` is `scoped` for background roles and `manage` for the interactive assistant, which can also queue and cancel jobs. See [MCP tools](mcp.md).

## Verdicts need evidence

The MCP server validates every write from an agent:

- A `pass` or `finding` verdict needs a reason and code references to files that exist in the run's checkout.
- A `finding` verdict needs a linked finding, and `find_similar` must run before a new finding is created.
- A `pass` whose reason is "the scanners found nothing" is refused; the reason must come from the code.
- A requirement's quote must be found in the document text.
- A vulnerable package must appear in a tool report that the run saved.
- A proposed document change must quote a page downloaded in that same run.

## Freshness (`stale`)

Each verdict and map snapshot stores its commit and the files it depends on: its evidence, the module's globs, and the call chains of the module's map. On display, the app compares them with the current `HEAD` using `git diff --name-only`:

- no overlap: the record stays valid;
- overlap: the record is marked `stale`;
- the commit is unreachable: the record is marked `stale`.

A verdict also becomes `stale` when a new document version changes its requirement's text. Only commits count; uncommitted edits don't. The check calls no AI, and rechecks start only by hand or by schedule.

## History

History is append-only; database triggers forbid updates and deletes. A run is a permanent record with its commit, a snapshot of the effective configuration, the session id, tokens and cost. A cell's current status is its latest verdict. A manual edit adds a record with the author `human`. Author values: `human`, `auto` (decided by the app without AI), `ai:<role>`.

## Estimates before spending tokens

Potentially large runs show an estimate first: sessions, items, tokens. The per-item figure is the average of the role's recent successful runs, or a configured default when the role has no history yet, so the first estimate is rough. The CLI asks for the same confirmation; `--yes` skips it.

Writing documents with AI has no estimate.

## What aiegis does not do

Out of scope: AST slicing, a built-in chat, fix or test generation as a separate feature (a fix session is an ordinary agent session), ZAP, export to PDF, SARIF or Jira, threat modeling. A document written by AI is a list of checkable requirements, not a threat model.
