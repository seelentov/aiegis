# Service and CLI

The `aiegis` executable runs aiegis without a window on Linux servers. Started without arguments it is the service and runs until stopped; with a subcommand it is a client that connects to the running service, executes the command and exits.

Download `aiegis-<version>-linux-x64` or `-arm64` from [releases](https://github.com/seelentov/aiegis/releases/latest), or build for the current architecture with `npm run dist:service` on Node 24. For development on macOS use `node dist/cli.js`.

`claude` (or `pi`) and the scanners are installed separately. Everything else is bundled; runtime files unpack to `<data>/runtime/<hash>` at startup.

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

Every desktop app operation that doesn't need a screen or a terminal has a command, see the [CLI reference](cli.md).

## CLI conventions

| Topic | Rule |
|---|---|
| Project | The registered project containing the current directory, or `--project <name or id>`. Ambiguity is an error that lists the candidates |
| Output | Tables for lists, indented JSON otherwise; `--json` forces JSON |
| Estimates | Run commands print the estimate and ask for confirmation; `--yes` skips it. Without a TTY and without `--yes` they fail instead of hanging |
| Paths | Relative paths are resolved before sending |
| Exit codes | `0` success, `1` error, `2` service not running |
| Raw calls | `aiegis call <method> [json args]` calls any API method with a JSON array of arguments |

## Running under systemd

`User` must be the account `claude` is logged in under. `TimeoutStopSec` gives agents time to stop.

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

There are no `serve`, `stop` or `install` commands; systemd, a terminal or `&` manage the process.

## Access

The control channel is a unix socket `<data>/aiegis.sock` with mode `0600`. File permissions are the only authentication: only the service's OS user can connect. Remote access goes through `ssh`.

A socket path over 103 bytes is an error, since the OS would truncate it silently. Move the data directory with `AIEGIS_DATA` in that case.

## Stopping and restarting

On `SIGTERM` or `SIGINT` the service stops its agents and returns their jobs to the queue; they resume after the next start. The desktop app cancels running jobs on exit instead.

The service and the desktop app can't share a data directory: a lock file makes the second one exit with an error. A lock older than the current OS boot counts as stale, so the service starts after a power loss.

## Differences from the desktop app

| | Desktop app | Service |
|---|---|---|
| Interactive sessions, fix sessions, taking over | Yes | No: these commands return an error |
| Opening files in VS Code, file dialogs | Yes | Pass a path as an argument instead |
| Running jobs when stopped | Cancelled | Back in the queue |
| Platforms | macOS, Windows, Linux | Linux x64, arm64; macOS for development |

## On Linux

- The user's shell must be `bash`.
- If `claude` isn't found, set its full path in `claude.binary`.
- PoC account secrets come only from `env` (`Environment=` or `EnvironmentFile=` in the unit), since Linux has no keychain support.
- The PoC tester needs a sandbox; see [PoC on Linux](poc.md#linux).

## Logs

stderr (`journalctl -u aiegis`) and `<data>/logs/aiegis.log`. `aiegis log-level [category] <level>` changes a level until restart. See [Data and logs](data-and-logs.md#logs).
