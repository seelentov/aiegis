# Service and CLI

The `aiegis` executable works without a window on Linux servers, and is controlled with the same executable. Without arguments it is the service, which runs until stopped. Any subcommand is a client: it connects to the service, does its work and exits.

Get `aiegis-<version>-linux-x64` or `-arm64` from the [releases](https://github.com/seelentov/aiegis/releases/latest), or build it with `npm run dist:service` on Node 24 for the current architecture. On macOS, for development, use `node dist/cli.js`.

`claude` (or `pi`) and the scanners are installed on the server separately. Everything else is built in, and runtime files unpack to `<data>/runtime/<hash>` at startup.

## Quick start

```bash
aiegis                                # the service: runs until SIGTERM or Ctrl+C
aiegis project add /srv/repos/shop    # other commands talk to the running service
aiegis doc import ./guide.md          # inside the project folder; otherwise --project <name or id>
aiegis matrix run main --module auth  # shows the token estimate and asks; --yes skips it
aiegis job list
aiegis watch <job>                    # the job's output; Ctrl+C only stops watching
aiegis status
aiegis help                           # all commands
```

Every feature of the desktop app is available as a command, except what needs a screen or a terminal. See the [CLI reference](cli.md).

## CLI conventions

- **Project:** the registered project around the current directory, or `--project <name or id>`. An ambiguous choice is an error listing the options.
- **Output:** tables for lists, indented JSON otherwise. `--json` gives JSON everywhere.
- **Estimates:** run commands show the estimate and ask for confirmation. `--yes` skips it. Without a terminal and without `--yes`, they fail instead of hanging.
- **Paths:** relative paths are made absolute before they are sent.
- **Exit codes:** `0` success, `1` error, `2` the service is not running.
- **Any method:** `aiegis call <method> [json args]` calls any API method with a JSON array of arguments.

## Running under systemd

`User` is the user `claude` is logged in as. Allow time for agents to stop.

```ini
[Unit]
Description=aiegis
After=network.target

[Service]
User=appsec
ExecStart=/usr/local/bin/aiegis
Restart=on-failure
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

There are no `serve`, `stop` or `install` commands. systemd, your terminal or `&` manage the process.

## Access

The control channel is a local unix socket, `<data>/aiegis.sock`, with mode `0600`. Only the service's OS user can use it, and it has no other authentication. From another machine, use `ssh`.

A socket path longer than 103 bytes is an error, because the OS would silently cut it. Move the data directory with `AIEGIS_DATA` if this happens.

## Stopping and restarting

On `SIGTERM` or `SIGINT`, the service stops its agents, returns their jobs to the queue and continues them after the next start. Closing the desktop app is different: its running jobs are cancelled.

The service and the desktop app cannot both run on one data directory. A lock file prevents it, and the second one refuses to start with a clear message. A lock older than the current OS boot is treated as stale, so the service starts after a power failure.

## Differences from the desktop app

| | Desktop app | Service |
|---|---|---|
| Interactive sessions, fix sessions, taking over | Yes | No: these commands return an error |
| Opening files in VS Code, file dialogs | Yes | Pass a path as an argument instead |
| Running jobs when stopped | Cancelled | Back in the queue |
| Platforms | macOS, Windows, Linux | Linux x64, arm64; macOS for development |

## On Linux

- The user's shell must be `bash`.
- If `claude` is not found, set its full path in `claude.binary`.
- Secrets of test accounts come only from `env` (`Environment=` or `EnvironmentFile=` in the unit file), since there is no keychain.
- The PoC tester needs a sandbox; see [PoC on Linux](poc.md#linux).

## Logs

stderr (`journalctl -u aiegis`) and `<data>/logs/aiegis.log`. Change a level until the next restart with `aiegis log-level [category] <level>`. See [Data and logs](data-and-logs.md#logs).
