# Security

aiegis feeds untrusted code, diffs and web pages to an AI agent. This page lists the controls and the gaps they leave.

## Controls

| Control | Mechanism |
|---|---|
| Working tree isolation | Background runs use a pinned commit in a separate `git worktree` |
| Per-session MCP token | The MCP server listens on `127.0.0.1` on a random port. The token binds project, role and writable entities; out-of-scope writes are refused. See [MCP tools](mcp.md#access) |
| Per-role tool permissions | Claude Code gets `--allowedTools` and `--disallowedTools`; under pi the aiegis extension checks each call. Most background roles are read-only. See [Roles](configuration.md#roles) |
| Clean agent setup | Default `claude.background_args` and `pi.background_args` exclude your hooks, plugins, extensions and skills from background runs |
| Result validation | Evidence files must exist, quotes must match, vulnerable packages must appear in saved reports. See [Verdicts need evidence](concepts.md#verdicts-need-evidence) |
| Append-only history | Database triggers block rewriting finished runs, approved versions, verdicts and scans |

## Secrets

- Scanner secrets are masked or dropped; raw reports live in a `0700` directory until normalization. See [Signals](signals.md#what-a-signal-holds).
- PoC account secrets come from the environment or the macOS keychain. They aren't written to files or the run's configuration snapshot; prompts contain only variable names.
- The app log never contains MCP tokens, `env` values, prompts or agent output.
- Agent output is stored in run logs under the data directory. Treat the directory as sensitive: tester runs can contain instance responses.

## Untrusted content

Repository code, diffs and web pages can contain prompt injections. Prompts tell agents to treat such content as data, but a prompt isn't a security boundary; permissions limit what a misled agent can do.

| Role | Reads untrusted input | Main limit |
|---|---|---|
| `matrix`, `sca`, `entry-points`, `modules`, `diff-check` | Code | No writes. `git` commands only, and `--output` is denied for `diff-check` |
| `doc-refresh` | Web pages | No shell or writes; its own directory only; downloads through `fetch_url` |
| `finding-verify` | Code and the text of the finding | Read-only checkout, no `git diff`, MCP token limited to its own result |
| `matrix` and others reading `get_signals` | Imported SARIF reports | Texts are cleaned and marked `imported`. See [Importing SARIF](signals.md#importing-sarif) |
| `tester` | Code and instance responses | OS sandbox. See [Isolation](poc.md#isolation) |

## What is not isolated

Review this list before auditing an untrusted repository.

| Component | Exposure |
|---|---|
| `sca-inventory` | Gradle, Maven and other build tools execute the project's build scripts on your machine with network access and no OS sandbox. Role permissions restrict which commands the agent starts, not what the build scripts do |
| `env-setup` | Unrestricted `Bash` without a sandbox (builds, remote commands). No account secrets; only `poc.env_passthrough` from your environment |
| PoC test instance | `start` runs the project's code outside the sandbox with account secrets |
| Environment variables | Most background roles inherit the full environment; only the tester, its instance and env-setup are limited to `poc.env_passthrough`. Roles without `Bash` can't read it; widening a role's permissions changes that |
| Interactive sessions | **New session** and **Fix** run in the working directory and can modify code |
| `git diff` | Given paths outside the working tree, it compares those files, so `Bash(git diff:*)` reads any file your user can. Most roles also have unrestricted `Read`. `finding-verify` has neither, which keeps the original session's transcript out of reach |
| `manage` token | The assistant can read all project data and start work |
| Tester under Claude Code on macOS | `allowLocalBinding` lets scripts reach any `localhost` port. The internet stays closed; the MCP server requires a token. See [Isolation](poc.md#isolation) |
| `<repo>/.aiegis/config.yaml` | Trusted as is. It can change prompts, permissions, `env`, scanner binaries and PoC commands. Inspect `.aiegis/` of an untrusted repository before adding it, or delete it in a copy |
| Service socket | Authentication is file permissions only |

## Network

| Component | Reaches |
|---|---|
| The aiegis MCP server | Loopback only |
| The document refresher's downloads | Allowed hosts only; private addresses are blocked by default. See [Network limits](document-refresher.md#network-limits) |
| The PoC tester | `base_url` only |
| Scanners | Whatever the tool does: `semgrep --config p/default` fetches rules, and `trivy` fetches its database |
| Agents | Their model provider. Your code is sent to it as part of a session |

## Provider safety filters

Anthropic applies real-time cyber safeguards to its models, and they can block security work. According to its [help page](https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude), generally available models may be used for secure code review, finding vulnerabilities in your own code and triaging alerts, while exploit validation can be interrupted; the Cyber Verification Program described there reduces blocking. That's why `finding-verify` only reads source.

aiegis sessions on a regular subscription outside the program haven't been blocked so far, with Sonnet and Haiku. The classifiers are probabilistic, so this isn't a guarantee.

A blocked run ends with the status `refused` and fails its job, either with the provider's error text or with "no result was recorded"; the run log shows which. aiegis doesn't retry such runs automatically or switch models. `queue.pause_after_refusals` refusals in a row pause the queue for `queue.refusal_pause_sec`. Joining the program is the account owner's decision.

## Reporting a vulnerability

Use **Report a vulnerability** on the repository's Security tab. If that isn't available, open an [issue](https://github.com/seelentov/aiegis/issues) without exploit details and ask for a private channel.
