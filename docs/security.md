# Security

An audit tool reads untrusted code and gives it to an AI agent. This page describes the protections, and what they do not cover.

## What protects you

- **Your working tree stays untouched.** Background runs work on a pinned commit in a separate `git worktree`.
- **Each session has its own token.** The MCP server listens on `127.0.0.1` with a random port. The token fixes the project, role and writable entities, and writes outside that scope are refused. See [MCP tools](mcp.md#access).
- **Tool permissions are set by role.** Claude Code gets `--allowedTools` and `--disallowedTools`; for pi, the aiegis extension checks each call. Most background roles only read code. See [Roles](configuration.md#roles).
- **Background runs are isolated from your setup.** The default `claude.background_args` and `pi.background_args` leave out your hooks, plugins, extensions and skills.
- **Results are verified.** Evidence must exist, quotes must be found, and vulnerabilities must appear in saved reports. See [Verdicts need evidence](concepts.md#verdicts-need-evidence).
- **History is append-only.** Database triggers prevent rewriting finished runs, approved versions, verdicts and scans.

## Secrets

- Scanner secrets are masked or not stored, and raw reports stay in a `0700` directory until they are normalized. See [Signals](signals.md#what-a-signal-holds).
- Test account secrets come from the environment or the macOS keychain. They are not written to files or to the run's configuration snapshot, and prompts name only the variables.
- The log never contains MCP tokens, `env` values, prompts or agent output, and tokens of runs are masked.
- Agent output stays in the run's log under the data directory. Treat that directory as sensitive: runs of the tester can contain what the instance returned.

## Untrusted content

Repository code, diffs and web pages can contain text aimed at the agent. Prompts tell agents to treat them as data, and permissions limit what a misled agent can do, but prompts alone are not a security boundary.

| Role | Reads untrusted input | Main limit |
|---|---|---|
| `matrix`, `sca`, `entry-points`, `modules`, `diff-check` | Code | No writes. `git` commands only, and `--output` is denied for `diff-check` |
| `doc-refresh` | Web pages | No shell or writes; its own directory only; downloads through `fetch_url` |
| `finding-verify` | Code and the text of the finding | Read-only checkout, no `git diff`, MCP token limited to its own result |
| `tester` | Code and instance responses | OS sandbox. See [Isolation](poc.md#isolation) |

## What is not isolated

Know these before you audit a repository you do not trust:

- **`sca-inventory` runs build tools.** Gradle, Maven and others execute the project's build scripts on your machine, with network access and without an OS sandbox. Its permissions limit the commands the agent may start, not what those build scripts do.
- **`env-setup` has unrestricted `Bash`,** without a sandbox, so it can run builds and remote commands. It does not get account secrets, and sees only `poc.env_passthrough` of your environment.
- **The test instance** runs the project's code outside the sandbox, with account secrets, when `start` executes.
- **Most background roles inherit your whole environment** (only the tester, its instance and env-setup are limited to `poc.env_passthrough`). Roles without `Bash` cannot read it, but keep this in mind if you widen a role's permissions.
- **Interactive sessions** (**New session**, **Fix**) run in your working directory and can change your code, under the agent's normal prompts.
- **`git diff` can read outside the repository.** Given paths outside the working tree, it compares those files, so roles allowed `Bash(git diff:*)` can read any file your user can. Most roles also have an unrestricted `Read`. `finding-verify` has neither, to keep the transcript of the original session out of reach.
- **The `manage` token** of the assistant can read all project data and start work.
- **The tester under Claude Code on macOS** can reach any `localhost` port from scripts, because of `allowLocalBinding`. The internet stays closed, and the MCP server needs a token. See [Isolation](poc.md#isolation).
- **A project's `.aiegis/config.yaml` is trusted.** It can change prompts, permissions, `env`, scanner binaries and the commands of the PoC environment. Before you add a repository you do not trust, read its `.aiegis/` directory, or delete it in a copy.
- **The service's socket** has no authentication other than file permissions.

## Network

| Component | Reaches |
|---|---|
| The aiegis MCP server | Loopback only |
| The document refresher's downloads | Allowed hosts only; private addresses are blocked by default. See [Network limits](document-refresher.md#network-limits) |
| The PoC tester | `base_url` only |
| Scanners | Whatever the tool does: `semgrep --config p/default` fetches rules, and `trivy` fetches its database |
| Agents | Their model provider. Your code is sent to it as part of a session |

## Provider safety filters

Anthropic runs real-time cyber safeguards on its models, and they can block security work. Its [Cyber Verification Program](https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude) reduces blocking. Its help page says generally available models can be used for secure code review, finding vulnerabilities in your own source code and triaging security alerts, while exploit validation may be interrupted.

This is why `finding-verify` only reads source code. Test runs on a subscription outside the program were not blocked (Sonnet and Haiku, 19 sessions on a test repository and on a large real one). That is no guarantee: classifiers are probabilistic, a large run of many findings was not tested, and false blocks are reported.

No block has been observed in aiegis, so its exact form is unknown. A run stopped this way ends its job as failed: either with the text of the error, or with "no result was recorded". The run's log shows why. aiegis does not retry such a run and does not switch the model. Whether to join the program is up to the owner of the account.

## Reporting a vulnerability

Open an [issue](https://github.com/seelentov/aiegis/issues) with no exploit details, and ask for a private channel.
