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

`AIEGIS_HOME` overrides `~/.aiegis`, and `AIEGIS_DATA` overrides the data directory. Together they give you a fully separate instance.

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

Audit data lives in the database, not in settings: modules, documents, verdicts and schedules are not in `config.yaml`. Most of it is append-only, so the database grows with use. Worktrees can be large on big repositories.

**To back up** a project, stop the app and copy its `<project-id>` directory, plus `<repo>/.aiegis/`. Removing a project from the list does not delete its data: to free the space, delete the `<project-id>` directory while the app is stopped. You lose that project's audit history.

## What goes in the repository

`<repo>/.aiegis/config.yaml`, `<repo>/.aiegis/instructions/**` and `<repo>/.aiegis/poc/` belong in git, so your team reviews them with the code. If you do not want them in the repository, add `.aiegis/` to `.git/info/exclude`.

## Logs

There are two kinds:

- **App log:** stderr and `<data>/logs/aiegis.log`, rotated by size. Plain text with time, level, category and message.
- **Run logs:** an agent's output, in `<project-id>/logs/<run-id>.jsonl`. **Open the run log** opens one from a run's details, and `aiegis run show <run>` includes it.

| Level | What it records |
|---|---|
| `error` | Failures of runs, scanners, the database and MCP; unhandled exceptions |
| `warn` | Rate limit pauses, MCP refusals outside scope, unavailable scanners, expected errors |
| `info` | Start and stop, the life of jobs and runs, tokens per run, all notifications |
| `debug` | API and MCP calls (name and ids), commands starting agents and scanners, git and worktrees |
| `trace` | Queue steps and stream event types, without content |

At every level, the log leaves out MCP tokens, `env` values, prompts and agent output.

Settings are in [`logging`](configuration.md#logging), in the global config. Edits through the app or CLI apply immediately, and edits by hand apply after a restart. To change a level until the service restarts:

```bash
aiegis log-level debug
aiegis log-level queue trace
```

## Troubleshooting

| Problem | What to do |
|---|---|
| `claude` or a scanner is not found | Check it runs in a terminal, or use a full path in `claude.binary` or `scanners.<name>.binary`. Then use **Check scanner availability again** |
| A second instance refuses to start | The app or the service already runs on this data directory. Use a different `AIEGIS_DATA`, or stop the other |
| `aiegis` exits with code 2 | The service is not running |
| A run ends with `token_limit` | Raise `limits.max_tokens_per_run`, or lower `matrix.batch_size` (`matrix.economy_batch_size` for a merged session). **Retry** continues with what is left |
| The queue is paused | A provider limit was hit. Wait, or click **Continue** |
| A cell is `stale` after a commit | Expected: run **Stale**. The code or the requirement changed |
| A new role setting did not appear after an upgrade | Values of existing roles are not updated. Compare with [`defaults/config.yaml`](../defaults/config.yaml) |
| A warning says default files changed | You edited a prompt that also changed upstream. Merge it by hand |
| PoC says the environment did not start | Read the run's output, then run **Environment** to let env-setup fix it |
| `bwrap` fails on Ubuntu | See [PoC on Linux](poc.md#linux) |
| A session says it was created by another agent | Set `agent` back to the one that made it |
