# Data and logs

## Locations

| Path | Contents |
|---|---|
| `~/.aiegis/` | Global configuration and prompts |
| `<repo>/.aiegis/` | Project configuration, committed with the code |
| Data directory | Audit data of all projects |

The data directory is:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/aiegis/` |
| Windows | `%APPDATA%\aiegis\` |
| Linux | `$XDG_DATA_HOME/aiegis/`, by default `~/.local/share/aiegis/` |

`AIEGIS_HOME` overrides `~/.aiegis`, `AIEGIS_DATA` overrides the data directory; setting both gives a fully separate instance.

## The data directory

```text
projects.json                  registered projects
aiegis.sock                    control socket of the service
logs/aiegis.log                the app log
runtime/<hash>/                files the service unpacks
<project-id>/
  db.sqlite                    audit data: modules, documents, matrices, findings, runs, schedules
  documents/<version-id>/      source.<ext>, text.md, page-N.html
  sca-reports/                 tool reports behind SCA items
  logs/<run-id>.jsonl          the agent output of a run
  worktrees/<sha>/             checkouts of audited commits
  sca-worktrees/<sha>/         checkouts for dependency inventories
  poc-worktrees/<sha>/         checkouts for test instances
  doc-gen/                     plans and drafts of AI-written documents
  poc-env-failure.log          output of the last test instance that did not start
```

A project's id is the first 16 hex characters of the SHA-256 of the real path of its root.

Audit data (modules, documents, verdicts, schedules) lives in the database, not in `config.yaml`. Most tables are append-only, so the database only grows. Worktrees of large repositories take significant disk space.

Backup: stop the app and copy the `<project-id>` directory and `<repo>/.aiegis/`. Removing a project from the list keeps its data; to free the space, delete `<project-id>` while the app is stopped, which destroys the project's audit history.

## What goes in the repository

`<repo>/.aiegis/config.yaml`, `<repo>/.aiegis/instructions/**` and `<repo>/.aiegis/poc/` are meant to be committed and reviewed with the code. To keep them local, add `.aiegis/` to `.git/info/exclude`.

## Logs

The app log goes to stderr and `<data>/logs/aiegis.log`, rotated by size, as plain text lines with time, level, category and message. Run logs hold agent output in `<project-id>/logs/<run-id>.jsonl`; **Open the run log** in run details and `aiegis run show <run>` show them.

| Level | What it records |
|---|---|
| `error` | Failures of runs, scanners, the database and MCP; unhandled exceptions |
| `warn` | Rate limit pauses, MCP refusals outside scope, unavailable scanners, expected errors |
| `info` | Start and stop, the life of jobs and runs, tokens per run, all notifications |
| `debug` | API and MCP calls (name and ids), commands starting agents and scanners, git and worktrees |
| `trace` | Queue steps and stream event types, without content |

No level logs MCP tokens, `env` values, prompts or agent output.

Settings: [`logging`](configuration.md#logging) in the global config. Changes through the app or CLI apply immediately, manual file edits after restart. Temporary level change until restart:

```bash
aiegis log-level debug
aiegis log-level queue trace
```

## Troubleshooting

| Problem | What to do |
|---|---|
| `claude` or a scanner isn't found | Check that it runs in a terminal, or set a full path in `claude.binary` or `scanners.<name>.binary`, then **Check scanner availability again** |
| A second instance refuses to start | The app or the service already uses this data directory. Stop it or set a different `AIEGIS_DATA` |
| `aiegis` exits with code 2 | The service is not running |
| A run ends with `token_limit` | Raise `limits.max_tokens_per_run`, or lower `matrix.batch_size` (`matrix.economy_batch_size` for a merged session). **Retry** continues with what is left |
| A job fails with "the MCP server did not connect" | Claude Code didn't reach the MCP server within its 30 s connect timeout, so the session couldn't record anything. Usually the app was busy; **Retry**. Claude Code only; pi reports MCP errors as tool errors |
| A run ends with `refused` | The provider's safety filter declined the task. The filter is probabilistic, so **Retry** may pass. If refusals repeat, ask the provider about enabling security work for the account, or set another model for the role. `queue.pause_after_refusals` refusals in a row pause the queue for `queue.refusal_pause_sec`; **Continue** in **Queue** resumes it |
| The queue is paused | A provider rate limit was hit. Wait or press **Continue** |
| A cell is `stale` after a commit | Expected: its code or requirement changed. Run **Stale** |
| A new role setting is missing after an upgrade | Upgrades don't change existing role values. Compare with [`defaults/config.yaml`](../defaults/config.yaml) |
| A warning says default files changed | A prompt you edited also changed upstream. Merge by hand |
| PoC reports the environment didn't start | Read the run output, then run **Environment** so env-setup fixes it |
| `bwrap` fails on Ubuntu | See [PoC on Linux](poc.md#linux) |
| A session reports it was created by another agent | Set `agent` back to the agent that created it |
