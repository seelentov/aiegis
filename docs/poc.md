# PoC tester

The PoC tester tries to reproduce a `suspected` finding against a running test instance and sends requests only to that instance. The result is evidence for a person; the finding's status doesn't change.

![The PoC tester section of a finding](screenshots/poc.png)

## The test environment

The environment is defined in the project configuration. Without it the tester is disabled and the button's tooltip says why.

```yaml
# <repo>/.aiegis/config.yaml
poc:
  environment:
    start: npm ci --silent && PORT=3100 node server.js
    healthcheck: curl -sf http://127.0.0.1:3100/health
    stop: ""
    base_url: http://127.0.0.1:3100
    accounts:
      alice: { username: alice, role: customer, tenant: a, secrets: { password: { env: POC_ALICE_PASSWORD } } }
      admin: { username: admin, role: admin, secrets: { password: { keychain: { service: aiegis-poc, account: admin } } } }
```

- `start`, `healthcheck` and `stop` run with `sh -c` in the worktree. `start` may stay in the foreground or exit after starting the service.
- `base_url` must be `http` or `https`.
- Account fields: `username`, `role`, `tenant`, `notes`, `secrets`.

Secrets come from the app's environment or the macOS keychain, never from the file. The instance and the tester get them as `AIEGIS_POC_<ACCOUNT>_<SECRET>`; the prompt contains only variable names. A missing secret fails the job. Linux has no keychain support; use `env`.

Commands and the tester inherit only the variables in `poc.env_passthrough`, plus the cascade's `env`, account secrets, `AIEGIS_POC_BASE_URL` and `AIEGIS_POC_SCRIPTS`. Build variables such as `JAVA_HOME` go into the project configuration.

## Letting an agent set it up

**Environment** starts the `env-setup` role, which figures out how to start the project:

1. It reads the code, docs, `AGENTS.md`/`CLAUDE.md`, skills and build files in a worktree, and also your checkout for git-ignored local files. Its prompt forbids writing there.
2. It calls `set_poc_environment`: commands replace `poc.environment` in `.aiegis/config.yaml`, keeping accounts, other keys and comments, and scripts go to `<repo>/.aiegis/poc/`. Leaving out `stop` keeps the current one; an empty string removes it.
3. It tests with `check_poc_environment` (`start`, `status`, `stop`), reads the service logs while waiting, fixes problems and retries. One polling call waits at most `poc.check_wait_max_sec`.

The session succeeds if its last check of the current environment returned `ready`. Otherwise the app runs `start`, `healthcheck`, `stop` itself after the session and fails the job if they don't pass.

Output of a failed start (from the tester or env-setup) is saved for the next env-setup session: first 40 and last 80 lines, each cut to 400 characters, repeated lines collapsed. The next attempt starts only by hand.

> env-setup runs without a sandbox. It has unrestricted `Bash` for builds and remote commands, but no account secrets, no `Edit`/`Write`, and only `poc.env_passthrough` from your environment. Its `check_poc_environment` calls start the instance with secrets.

## Running the tester

**PoC** in a finding's details runs the tester. It's enabled for a live `suspected` finding with no active PoC job. The job:

1. creates a worktree of `HEAD` under `poc-worktrees/<sha>` (its build writes there);
2. runs `start`, and polls `healthcheck` every `healthcheck_interval_sec` until it exits 0 or `start_timeout_sec` passes;
3. runs the agent (role `tester`), with its scripts in `.aiegis-poc/<job-id>/`;
4. runs `stop` (up to `stop_timeout_sec`) and kills what remains of the `start` process group.

If the instance doesn't start, the run fails without calling the agent. Instance output goes to the run's stream. Testers and env-setup share one instance per project and run one at a time.

## Results

`reproduced`, `not_reproduced` or `inconclusive`. The first two require the steps and observed responses. `reproduced` means the exact effect the finding claims; a weaker effect is `inconclusive` with a description of what was shown. Results are append-only and record commit, `base_url`, run and author. A run that exits normally without a result ends with an error. After `reproduced` the panel notes that `verified` is set by a person.

## Isolation

| Layer | Claude Code | pi |
|---|---|---|
| OS sandbox | `poc.claude_settings`, passed with `--settings` | `poc.pi_sandbox`, applied by the aiegis extension |
| Engine | Seatbelt on macOS, bubblewrap on Linux | The same, through `@anthropic-ai/sandbox-runtime` |
| Network | The `base_url` host is added to the allowlist | Same |
| Writes | Only the working tree, and tool writes only to `.aiegis-poc/` | Only the working directory |
| Hook | A `PreToolUse` hook refuses commands addressing other hosts, redirection options of `curl` and `dangerouslyDisableSandbox` | The same hook runs before each `bash` command |
| No sandbox available | `failIfUnavailable` stops the session | Commands are blocked |

The tester's tools are `Read`, `Grep`, `Glob`, the MCP server, `Edit` and `Write` in `.aiegis-poc/`, and `Bash` limited to `git log`, `git show`, `ls`, `mkdir`, `curl`, `jq`, `python3`, `node`, one simple command per call.

Access to a local instance differs by agent. Claude Code on macOS needs `allowLocalBinding: true` (on by default) to reach `localhost`, which opens every local port to scripts, including the aiegis MCP server (token required). The internet stays closed and the hook restricts `curl` URLs to `base_url`. On Linux, Claude Code requests go through the sandbox proxy, which allows only `base_url`. pi always goes through the proxy, so exactly the `host:port` of `base_url` is open.

## Linux

The sandbox needs `socat` and `bubblewrap`. On Ubuntu 24.04, an AppArmor profile is also needed, or `bwrap` fails with `Failed RTM_NEWADDR: Operation not permitted`:

```bash
sudo apt install bubblewrap socat
printf 'abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\n' | sudo tee /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

The service user's shell must be `bash`. On Windows without WSL2, `failIfUnavailable` blocks tester sessions.

## Command line

```bash
aiegis poc setup            # env-setup
aiegis finding poc <finding>
```
