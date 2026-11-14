# Matrix

A matrix is requirements × modules. Each cell holds a verdict with a reason and code references.

![The matrix with the details of a cell](screenshots/matrix.png)

## Creating a matrix

A matrix has a name, a list of documents (their approved versions) and a list of modules; an empty module list means all current modules. **+** creates a matrix, the pencil edits it. Ticking a document set adds all its approved documents.

Cells are global: the verdict for a module × requirement pair is shared by every matrix that contains it.

## Cell statuses

| Status | Meaning | The verdict needs |
|---|---|---|
| `not checked` | No verdict yet | |
| `n/a` | The requirement does not apply to this module | A reason |
| `pass` | The requirement holds | A reason and code references |
| `finding` | The requirement is broken | A reason, code references and a linked finding |
| `needs human` | The agent could not decide | A reason |

A `pass` must cite the code that satisfies the requirement. The agent has to check every place in the module the requirement applies to; a missing control means `finding` or `needs human`. A `pass` based on empty scanner output is rejected.

`stale` is a flag on top of the status: the code or the requirement changed after the verdict, see [freshness](concepts.md#freshness-stale). `applicable` marks a cell that triage passed on to the verdict stage; its status stays `not checked`.

Counters above the grid act as row filters; the requirement column filter also matches document titles. Rows are grouped by document and section. The header shows the commit the verdicts are evaluated against.

## Running checks

Each run starts with an [estimate](#estimates).

| Button | Stage | Cells it takes |
|---|---|---|
| **n/a triage** | Stage 1 (role `matrix-triage`, a cheap model) | `not checked` without a triage mark. One session per module, up to `matrix.triage_batch_size` cells |
| **Verdicts** | Stage 2 (role `matrix`) | All `not checked`. One session per module × section, up to `matrix.batch_size` cells |
| **Stale** | Stage 2 | All `stale` cells, in any status |
| **Verdicts** in the actions of a column, row, section or cell | Stage 2 | The `not checked` and `stale` cells of that slice, or all of them if there are none |
| **n/a triage** in the same actions | Stage 1 | The cells of that slice the whole-matrix triage would take |
| **Recheck** in the details | Stage 2 | The selected cell |

These actions are in the context menu of a column header, row, section or cell, and under **⋯** next to them. **Set a verdict…** in the same menu writes one manual verdict with one rationale and evidence to every cell of the slice, in a single transaction.

Cells already covered by a queued or running job are skipped. A cell with its own `requirements.<key>` configuration level gets a separate session so that level takes effect.

Verdicts are written per cell as soon as the agent decides them. After a crash, rate limit or token limit, **Retry** rebuilds the prompt from the cells still without a result; if none are left, the job finishes without starting the agent. A run that exits normally but leaves cells undecided ends with an error so **Retry** picks them up.

With `signals.auto_scan` on, missing scans for the batch's modules are queued first; verdict sessions wait for them without blocking other jobs. Agents receive signals as hints only, see [Signals](signals.md).

### Estimates

![The estimate before a verdict run](screenshots/matrix-estimate.png)

The estimate shows sessions, cells and tokens (cells × tokens per cell). Tokens per cell is the average billable tokens over the role's last `matrix.estimate_history_runs` successful runs, or `matrix.estimate_tokens_per_cell` without history.

Warnings:

- a session may exceed `limits.max_tokens_per_run`: lower `matrix.batch_size` or raise the limit;
- modules without a complete entry point map (interrupted maps count as incomplete): their sessions search the code without a map. **Build maps** queues the missing maps. In the CLI the list is `modulesWithoutMap` in the estimate output, and `entry-points build <module>` builds a map.

The token limit counts input, cache creation and output tokens, not cache reads. A run that exceeds it stops with the status `token_limit`.

### Merged sessions for large runs

A verdict run estimated above `matrix.economy_above_tokens` (default 1,000,000) runs as a few merged sessions (task `matrix_economy`, role `matrix-economy`): the agent reads the code once and decides requirements in groups. Cells of one module stay in one session, up to `matrix.economy_batch_size`; modules with few cells share a session. Cells with their own cascade level get regular sessions.

Merged sessions cost several times less and miss more, including false `pass` verdicts. Their verdicts are marked preliminary: a star in the cell, a label in the details, a filter above the grid. **Preliminary** rechecks them in regular sessions; any later verdict clears the mark.

The estimate panel shows both totals and a mode switch; in the CLI, `--force` keeps regular sessions. A retry keeps the job's mode. Schedules follow the threshold. `0` disables merged sessions.

## Cell details

- Requirement, citation, quote.
- Status, rationale, evidence with links to the code.
- Author, time, commit, link to the run.
- Buttons: **Recheck**, the verdict session, **Verdict** (manual), **Finding** (manual), **Link the finding to the cell**.
- **Findings** linked to the cell.
- **History** of verdicts, triage and finding events. Ticking two verdicts opens a comparison of status, author, commit, model, effort, rationale and evidence.
- **Effective configuration of the check**.

A manual verdict gets the author `human` and the `HEAD` of the working copy; its evidence is validated against that commit. Evidence format: one reference per line, `path[:line] [note]`, relative to the repository root.

## Rechecking after a fix

When an interactive session commits in the working directory, the app detects the new `HEAD` and offers to recheck the cells whose verdicts depend on the changed files, plus the finding's cells after a fix session. The offer stays until accepted or dismissed and leads to an estimate and confirmation. A cell present in several matrices takes the configuration level of the matrix it was opened from, otherwise of the first matrix by name.

## Command line

```bash
aiegis matrix list
aiegis matrix save 'Guideline' --document <id> --module api --module admin
aiegis matrix show <matrix>
aiegis matrix estimate <matrix> --stage verdicts --scope pending
aiegis matrix run <matrix> --stage triage
aiegis matrix run <matrix> --stage verdicts --scope stale
aiegis matrix run <matrix> --module api            # also --requirement, --section
aiegis matrix run <matrix> --stage triage --module api
aiegis matrix slice <matrix> --module api
aiegis cell show <module id>/<requirement id>
aiegis cell estimate <cell>...
aiegis cell run <cell>...
aiegis cell verdict <cell> pass 'Checked by the middleware' --evidence lib/auth.js:12
aiegis cell bulk-verdict n/a 'No HTTP in this module' <cell>...
```

Run commands print the estimate and ask for confirmation; `--yes` skips it. Full list in the [CLI reference](cli.md#matrix).
