# MCP tools

Agents talk to aiegis through an MCP server inside the app (stateless Streamable HTTP on `127.0.0.1`, a random port, `/mcp`). You do not call these tools yourself; this page shows what an agent can do and how it is limited.

## Access

Each session gets its own token, in a `0600` file that is removed when the run ends. The token fixes:

- **project**: a token reads only its own project;
- **scope**: the entities it may write, for example `cell:<module>/<requirement>` or `doc_version:<id>`;
- **access**: `scoped` for background roles. `manage` for the interactive assistant, which can also start and cancel work. Management does not grant write access to entities.

Writes that check files need a live run, so a token stops writing once its run ends. Refusals are logged. Schedules are not available over MCP.

## Common

| Tool | What it does |
|---|---|
| `whoami` | Project, role, access level, session and run ids, writable entities |
| `list_jobs` | Background jobs and the queue state |
| `list_runs` | Recent runs |
| `get_results` | Results written by agents, optionally by entity |
| `submit_result` | Writes a result for an entity in scope |

## Modules and entry points

| Tool | What it does |
|---|---|
| `list_modules` | Current modules: id, name, globs, description |
| `upsert_module` | Creates or updates a module, matched by id or else by name. Globs must match tracked files |
| `remove_module` | Removes a module; the history stays |
| `get_entry_points` | A module's map: the latest complete snapshot, or a given one. A large map comes as a brief list, `keys` returns chosen entries in full |
| `upsert_entry_point` | Records an entry point in this run's snapshot. The same kind, method and name replaces it |
| `remove_entry_point` | Removes one from this run's snapshot |

## Documents

| Tool | What it does |
|---|---|
| `list_documents` | Documents with their versions and review status |
| `get_requirements` | Items of a version. By default, the accepted items of the current approved version |
| `add_requirement` | Records a requirement. The quote must be word for word, and the same key replaces the item |
| `set_document_info` | Records how a version names itself, only as printed |
| `append_document_text` | Saves a document's text in parts, in reading order, when reading a PDF |
| `plan_security_documents` | Records the plan of AI-written documents. Every module must be covered |
| `save_security_document` | Records the Markdown text of a planned document |

## Document refresher

| Tool | What it does |
|---|---|
| `fetch_url` | Downloads a page or file from an allowed host |
| `report_document_check` | Records `current` (with a fetch and what shows it) or `unverifiable` (with a reason) |
| `request_document_review` | In a set check: hands a document to its own comparison |
| `request_catalogue_review` | In a set check: marks a page as a catalogue, to be judged entry by entry |
| `judge_catalogue_entries` | In a catalogue run: records the decision on entries |
| `propose_document_change` | Proposes a change for a person to decide. The app verifies it first |

## Matrix and branch checks

| Tool | What it does |
|---|---|
| `list_matrices` | Matrices of the project |
| `get_matrix` | Cells of a matrix: status, `stale` flag, finding count |
| `get_cell` | One cell: requirement, verdict history, triage, linked findings |
| `triage_cell` | Applicability: `applicable=false` marks it `n/a`, with a reason |
| `set_verdict` | Verdict for a cell in scope |
| `set_diff_verdicts` | Verdicts of a branch check, many in one call. Invalid entries come back in `rejected` |
| `recheck_cells` | Queues rechecks. `manage` only; shows no estimate |

## Findings

| Tool | What it does |
|---|---|
| `list_findings` | Findings, without merged ones |
| `find_similar` | Mandatory deduplication check. Returns the `check_id` that `create_finding` needs |
| `create_finding` | Creates a `suspected` finding linked to a cell in scope; optional `trace` is its data flow, input first, sink last, every file must exist |
| `link_finding` | Links an existing finding to a cell in scope |

## Signals

| Tool | What it does |
|---|---|
| `get_signals` | Scanner signals in a module's files, minus suppressed ones. See [how agents read signals](signals.md#how-agents-read-signals) |

## SCA

| Tool | What it does |
|---|---|
| `get_sca_inventory` | A module's vulnerable packages and their reachability status |
| `add_vulnerable_package` | Records a package@version. Each vulnerability must be in a saved tool report |
| `remove_vulnerable_package` | Removes one from this run's inventory |
| `set_inventory_summary` | Finishes an inventory. Mandatory, even when nothing vulnerable was found |
| `set_sca_verdict` | Reachability verdict for one vulnerability |
| `create_sca_finding` | Creates a `suspected` finding for reachable vulnerabilities; optional `trace` as in `create_finding` |
| `link_sca_finding` | Links an existing finding to vulnerabilities of the package |
| `mark_files_reviewed` | Hunt: records files of the module in scope (`hunt:<module_id>`) the session finished reading, with a note |
| `create_hunt_finding` | Hunt: creates a `suspected` finding in the module, not tied to a requirement; needs `check_id` from `find_similar`; at least one file must belong to the module; optional `trace` |

## Independent verification

The token of the role `finding-verify` has only `whoami` and the tool of its task.

| Tool | What it does |
|---|---|
| `set_finding_verification` | Result of a check: `refuted`, `confirmed` (both with code references) or `undetermined`. It does not change the finding's status, and every call is stored |
| `set_fix_verification` | Result of a fix check at the session's commit: `closed`, `not_closed` (both with code references) or `undetermined`. It does not change the finding's status, and every call is stored |

## PoC

| Tool | What it does |
|---|---|
| `set_poc_result` | Result of a PoC. It does not change the finding's status, and every call is stored |
| `set_poc_environment` | env-setup: how the app starts the test instance, and its scripts |
| `check_poc_environment` | env-setup: starts, polls or stops the saved environment |

## Management

`manage` access only.

| Tool | What it does |
|---|---|
| `enqueue_task` | Queues a background task |
| `cancel_job` | Cancels a queued or running job |
