# CLI reference

Every command talks to the running [service](service.md). In the examples, `aiegis` is the executable; for development, use `node dist/cli.js`.

```text
aiegis                      run the service until SIGTERM or SIGINT
aiegis <command> [options]  talk to the running service
```

**Options of every command:**

| Option | Meaning |
|---|---|
| `--project <name or id>` | The project. By default, the registered project around the current directory |
| `--json` | Print JSON instead of a table |
| `--yes` | Skip the confirmation after an estimate |

**Exit codes:** `0` success, `1` error, `2` the service is not running.

A repeated option, written as `--module <name>...`, can be given several times. Run `aiegis help` for this list in your version.

## General

| Command | What it does |
|---|---|
| `status` | Show that the service runs, its queue and projects |
| `watch [job]` | Follow the output of a job until it ends; without a job, the feed of events. Ctrl+C stops watching only |
| `log-level [category] <level>` | Change a log level until the service restarts |
| `call <method> [json args]` | Call any API method with a JSON array of arguments |
| `help` | Show this text |

## project

Projects. See [Interface](interface.md#projects).

| Command | What it does |
|---|---|
| `project list` | List projects |
| `project add <path>` | Register a git repository |
| `project remove` | Forget the project |

## job

Jobs. See [Queue and sessions](queue-and-sessions.md).

| Command | What it does |
|---|---|
| `job list` | List the latest 500 jobs |
| `job page [--offset <n>] [--limit <n>] [--sort <column>] [--desc] [--status <status>] [--role <role>] [--title <text>] [--created <text>]` | List a page of all jobs, newest first. `--limit` defaults to `ui.page_size`; `--sort` takes `status`, `title`, `role` or `created` |
| `job show <job>` | Show a job |
| `job add <prompt> [--role <role>] [--title <text>]` | Queue a free-form agent task |
| `job cancel <job>` | Cancel a job |
| `job retry <job>` | Retry a job |

## queue

Queue. See [Queue and sessions](queue-and-sessions.md).

| Command | What it does |
|---|---|
| `queue state` | Show the queue |
| `queue resume` | Resume a paused queue |

## run

Runs. See [Queue and sessions](queue-and-sessions.md).

| Command | What it does |
|---|---|
| `run list` | List the latest 500 runs |
| `run page [--offset <n>] [--limit <n>] [--sort <column>] [--desc] [--status <status>] [--role <role>] [--kind <kind>] [--session <text>] [--started <text>]` | List a page of all runs, newest first. `--sort` takes `started`, `kind`, `role`, `status`, `session`, `tokens` or `cost` |
| `run show <run>` | Show a run with its results and log |

## module

Modules. See [Modules](modules.md).

| Command | What it does |
|---|---|
| `module list` | List modules |
| `module history <module>` | Show the revisions of a module |
| `module preview <glob...>` | Show the files globs match |
| `module save <name> --glob <glob>... [--description <text>] [--id <module>]` | Create or change a module |
| `module remove <module> <reason>` | Remove a module |
| `module parse [--hint <text>]` | Queue AI markup of modules |

## entry-points

Entry points. See [Entry points](entry-points.md).

| Command | What it does |
|---|---|
| `entry-points build <module>` | Queue the entry point map of a module |
| `entry-points build-all` | Queue the entry point maps of all modules |
| `entry-points show <module> [--snapshot <id>]` | Show an entry point map |

## doc

Documents. See [Documents](documents.md).

| Command | What it does |
|---|---|
| `doc list` | List documents |
| `doc import <file> [--title <text>] [--document <id>] [--set <id>] [--source <url>] [--insecure]` | Upload a document, or a new version of one; queues requirement extraction |
| `doc source <document> [url] [--insecure]` | Set the link of a document, or clear it; --insecure does not verify the certificate of its host |
| `doc retire <document> <reason>` | Take a document out of force: it leaves matrices and checks, history stays |
| `doc restore <document>` | Bring a document back into force |
| `doc item-retire <reason> <requirement...>` | Take requirements out of force: they leave matrices and checks, their document and history stay |
| `doc item-restore <requirement...>` | Bring requirements back into force |
| `doc check-estimate (--set <id> \| --document <id>)` | Estimate a document check; nothing runs |
| `doc check (--set <id> \| --document <id>) [--force]` | Check a set or one document against its links; without AI when the sources did not change, unless --force |
| `doc plan [--hint <text>]` | Queue AI-written security documents |
| `doc rewrite <document> [--hint <text>]` | Queue a rewrite of an AI-written document |
| `doc show <version>` | Show a document version with its items |
| `doc retry <version>` | Retry requirement extraction |
| `doc state <version> <review\|discarded>` | Send a version to review or discard it |
| `doc review <version> <pending\|accepted\|rejected> <item...>` | Review extracted items |
| `doc item <version> --text <text> --section <name> [--key <key>] [--clause <text>] [--quote <text>]` | Add or change a requirement |
| `doc catalogue <set>` | Show the decision on every catalogue entry of a set |
| `doc info <version> [--name <text>] [--number <text>] [--date <text>] [--edition <text>]` | Set how a version is cited; a value left out becomes empty |
| `doc approve <version>` | Approve a reviewed version |
| `doc repeats` | Show requirements of different documents that probably say the same |
| `doc requirements` | List current requirements |

## doc-set

Document sets. See [Document refresher](document-refresher.md).

| Command | What it does |
|---|---|
| `doc-set list` | List document sets |
| `doc-set save <name> [--id <set>] [--scope <text>] [--link <url>] [--insecure-link <url>] [--document <id>]` | Create or update a document set; --insecure-link does not verify the certificate of that host; --document lists its whole membership |
| `doc-set remove <set>` | Remove a set; its documents stay, outside any set |
| `doc-set assign <document> [--set <id>]` | Move a document to a set, or out of any set without --set |

## doc-proposal

Document proposals. See [Document refresher](document-refresher.md).

| Command | What it does |
|---|---|
| `doc-proposal list` | List changes proposed by document checks |
| `doc-proposal accept <proposal> [--matrix <id>]` | Apply a proposal; a new document joins the given matrices, by default those with documents of its set |
| `doc-proposal reject <proposal> [reason]` | Reject a proposal; it is not proposed again while the source stays the same |
| `doc-proposal accept-additions <set>` | Apply all additions to an empty set |

## matrix

Matrix. See [Matrix](matrix.md).

| Command | What it does |
|---|---|
| `matrix list` | List matrices |
| `matrix save <name> --document <id>... --module <name>... [--id <matrix>]` | Create or change a matrix |
| `matrix show <matrix>` | Show a matrix |
| `matrix slice <matrix> [--module <name>...] [--requirement <key>...] [--section <name>] [--preliminary]` | List the cells a slice run would cover |
| `matrix estimate <matrix> [--stage <triage\|verdicts>] [--scope <pending\|stale>] [--force]` | Estimate a stage of a matrix; `--force` estimates the usual sessions of a large run |
| `matrix run <matrix> [--stage <triage\|verdicts>] [--scope <pending\|stale>] [--module <name>...] [--requirement <key>...] [--section <name>] [--preliminary] [--force]` | Run a stage of a whole matrix, or verdicts of a module, requirement, section or preliminary cells; `--force` keeps the usual sessions of a large run |

## cell

Cells. See [Matrix](matrix.md).

| Command | What it does |
|---|---|
| `cell estimate <cell...> [--matrix <matrix>] [--force]` | Estimate a recheck of cells |
| `cell run <cell...> [--matrix <matrix>] [--force]` | Run verdicts of cells (<module id>/<requirement id>) |
| `cell show <cell> [--matrix <matrix>]` | Show a cell |
| `cell verdict <cell> <status> <reason> [--evidence <file[:line]>...]` | Set a human verdict |

## finding

Findings. See [Findings](findings.md).

| Command | What it does |
|---|---|
| `finding list` | List findings |
| `finding show <finding>` | Show a finding |
| `finding status <finding> <status> <reason>` | Change the status of a finding |
| `finding merge <source> <target>` | Merge a finding into another |
| `finding create <cell> --title <text> --description <text> --severity <level> [--cwe <id>] [--entry-point <text>] [--recommendation <text>] [--evidence <file[:line]>...]` | Create a finding on a cell |
| `finding link <finding> <cell>` | Link a finding to a cell |
| `finding verify-estimate <finding...>` | Estimate an independent verification of findings |
| `finding verify <finding...>` | Queue a clean session per suspected finding that tries to refute it |
| `finding fix-state` | Show whether the files of live findings changed since their last fix check |
| `finding fix-estimate <finding...>` | Estimate fix checks of findings |
| `finding fix-check <finding...>` | Queue a clean session per finding that judges at HEAD whether it is closed |
| `finding poc <finding>` | Queue the PoC tester on a finding |

## poc

PoC. See [Poc](poc.md).

| Command | What it does |
|---|---|
| `poc setup` | Queue the setup of the test environment |

## scanner

Scanners. See [Signals](signals.md).

| Command | What it does |
|---|---|
| `scanner status [--refresh]` | Show scanners |
| `scanner run [--module <name>...] [--repository]` | Queue scans at HEAD: of modules (default: all) or of the whole repository |
| `scanner list` | List scans |
| `scanner import <file> [--commit <sha>] [--source-root <path>]` | Import a SARIF 2.1.0 report; --commit is required when the report names none |

## signal

Signals. See [Signals](signals.md).

| Command | What it does |
|---|---|
| `signal list [--commit <sha>]` | Show SAST signals |
| `signal show <signal>` | Show a signal |

## suppression

Suppressions. See [Signals](signals.md#suppressions).

| Command | What it does |
|---|---|
| `suppression list` | List suppressions |
| `suppression create --scope <scope> --reason <text> [--signal <id>] [--glob <glob>...] [--requirement <id>] [--module <name>] [--expires <date>]` | Create a suppression |
| `suppression revoke <suppression> <reason>` | Revoke a suppression |
| `suppression renew <suppression> [--expires <date>]` | Re-confirm a suppression at HEAD |

## sca

SCA. See [Sca](sca.md).

| Command | What it does |
|---|---|
| `sca show` | Show modules with their dependencies and SCA items |
| `sca item <item>` | Show an SCA item |
| `sca add-input <file> [--module <name>] [--note <text>]` | Add a lock file, SBOM or scanner report |
| `sca remove-input <input>` | Exclude a dependency file |
| `sca inventory [--module <name>...]` | Queue dependency inventories at HEAD |
| `sca estimate [--scope <pending\|stale>] [--module <name>...] [--item <id>...]` | Estimate an SCA run |
| `sca run [--scope <pending\|stale>] [--module <name>...] [--item <id>...]` | Run SCA verdicts |
| `sca verdict <item> <status> <reason> [--evidence <file[:line]>...]` | Set a human verdict on an SCA item |
| `sca finding <item> --title <text> --description <text> --severity <level> [--cwe <id>] [--entry-point <text>] [--recommendation <text>] [--evidence <file[:line]>...]` | Create a finding on an SCA item |
| `sca link <finding> <item>` | Link a finding to an SCA item |
| `sca report <report>` | Print the path of a stored report |

## diff

Branch checks. See [Branch check](branch-check.md).

| Command | What it does |
|---|---|
| `diff branches` | List branches |
| `diff estimate --base <branch> --head <branch> (--set <id> \| --document <id>)` | Estimate a branch check |
| `diff run --base <branch> --head <branch> (--set <id> \| --document <id>)` | Check the changes of a branch against a document set or a document |
| `diff list` | List branch checks |
| `diff show <check>` | Show a branch check |

## schedule

Schedules. See [Schedules](schedules.md).

| Command | What it does |
|---|---|
| `schedule list` | List schedules |
| `schedule show <schedule>` | Show a schedule |
| `schedule history <schedule> [--limit <n>]` | List firings of a schedule, newest first |
| `schedule add --name <text> --cron <expr> --action <task\|matrix\|scanners\|sca_inventory\|sca\|entry_points\|doc_refresh\|diff_check\|fix_verify> [--max-tokens <n\|default>] [--prompt <text>] [--role <role>] [--title <text>] [--matrix <matrix>] [--stage <triage\|verdicts>] [--scope <pending\|stale>] [--module <name>...] [--requirement <key>...] [--section <name>] [--cell <id>...] [--repository] [--base <branch>] [--head <branch>] [--set <id>] [--document <id>]` | Create a schedule; it runs while the app or the service is running, in the time zone of the OS |
| `schedule edit <schedule> [--name <text>] [--cron <expr>] [--action <task\|matrix\|scanners\|sca_inventory\|sca\|entry_points\|doc_refresh\|diff_check\|fix_verify>] [--max-tokens <n\|default>] [--prompt <text>] [--role <role>] [--title <text>] [--matrix <matrix>] [--stage <triage\|verdicts>] [--scope <pending\|stale>] [--module <name>...] [--requirement <key>...] [--section <name>] [--cell <id>...] [--repository] [--base <branch>] [--head <branch>] [--set <id>] [--document <id>]` | Change a schedule; --action replaces the whole action |
| `schedule enable <schedule>` | Enable a schedule |
| `schedule disable <schedule>` | Disable a schedule |
| `schedule remove <schedule>` | Remove a schedule; its firings stay in the history |
| `schedule run <schedule>` | Fire a schedule now, with the same checks as a planned firing |
| `schedule preview <cron>` | Show the next times of a cron expression |

## terminal

Terminals. See [Queue and sessions](queue-and-sessions.md#terminal-panel).

| Command | What it does |
|---|---|
| `terminal list` | List output streams |
| `terminal show <terminal>` | Print the scrollback of a stream |
| `terminal close <terminal>` | Close a stream |

## config

Configuration. See [Configuration](configuration.md).

| Command | What it does |
|---|---|
| `config roles [--global]` | List roles |
| `config default-role [--global]` | Print the default role of tasks |
| `config effective <role> [--global] [--module <name>] [--matrix <name>] [--item <key>]` | Show the effective config of a role with the source of each value |
| `config task-role <kind>` | Print the role of a task kind |
| `config files [--global]` | List config files |
| `config read <file> [--global]` | Print a config file |
| `config write <file> [--global]` | Replace a config file with stdin |

## Not available from the command line

These need a screen or a terminal, so they exist only in the desktop app: interactive sessions (new session, opening a run, taking over, fix sessions), the external terminal, opening files in the editor, and writing to or resizing a terminal. File dialogs are replaced by path arguments.
