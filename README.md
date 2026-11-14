<p align="center">
  <img src="build/icon.png" width="96" alt="aiegis" />
</p>

<h1 align="center">aiegis</h1>

<p align="center">
  A desktop app for AppSec code audits on top of <a href="https://docs.claude.com/en/docs/claude-code/overview">Claude Code</a> or <a href="https://pi.dev">pi</a>
</p>

<p align="center">
  <a href="https://github.com/seelentov/aiegis/releases/latest"><img src="https://img.shields.io/github/v/release/seelentov/aiegis?include_prereleases&style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platforms" />
</p>

<p align="center">
  <a href="docs/getting-started.md"><b>Getting started</b></a> ·
  <a href="docs/README.md"><b>Documentation</b></a> ·
  <a href="docs/cli.md"><b>CLI reference</b></a> ·
  <a href="https://github.com/seelentov/aiegis/releases/latest"><b>Download</b></a>
</p>

![The requirements matrix](docs/screenshots/matrix.png)

aiegis runs AppSec audits of a git repository with a local coding agent. Requirements from standards and internal guidelines form a matrix of requirement × module; a background agent session gives each cell a verdict (`n/a`, `pass`, `finding`, `needs_human`) with a reason and `file:line` references.

The app has no chat. It starts the agent (`claude` by default, or `pi`), keeps the data, prompts and configuration, and receives results through a built-in MCP server.

> Status: 0.x. Data and configuration formats may change between versions. macOS is the main platform; Windows and Linux builds are built in CI and tested less.

## Features

| Feature | What it does | Docs |
|---|---|---|
| Modules | Named sets of git globs, written by hand or proposed by the agent, with history | [Modules](docs/modules.md) |
| Entry point maps | HTTP, gRPC, GraphQL, queues, cron, CLI, WebSocket and plugins, with handler, middleware, authorization, parameters and call chains to sinks. Versioned by commit | [Entry points](docs/entry-points.md) |
| Documents to requirements | MD, PDF or DOCX upload, or documents written by the agent from the code. The agent extracts requirements with quotes, a person approves them, new versions show a diff | [Documents](docs/documents.md) |
| Document refresher | Compares document sets with their sources and proposes new editions, new documents, replacements and retirements. A person applies them; unchanged sources are not sent to the agent | [Document refresher](docs/document-refresher.md) |
| Matrix | A cheap `n/a` triage, then `pass`, `finding` or `needs_human` verdicts with reasons and code references. Runs by column, row or section after a token estimate | [Matrix](docs/matrix.md) |
| Vulnerability hunt | Reads every file of a module looking for exploitable flaws outside the requirements. Records which files were read; the next hunt reads only unread and changed files | [Modules](docs/modules.md#vulnerability-hunt) |
| Findings | A `suspected → verified, false_positive, accepted_risk, fixed` lifecycle, mandatory deduplication, merging, the data flow from attacker input to the sink, independent verification, and fix sessions | [Findings](docs/findings.md) |
| SAST signals | Semgrep, Gitleaks and Trivy run once per commit. Results are normalized and passed to the agent as hints. Suppressions store a reason, author and expiry | [Signals](docs/signals.md) |
| SCA | An AI dependency inventory backed by tool reports, a prefilter without AI, and reachability per package. A reachable vulnerability becomes a finding | [SCA](docs/sca.md) |
| PoC tester | Starts a test instance from a worktree and checks a finding with requests only to `base_url`, in an OS sandbox. An agent can work out how to start your project | [PoC tester](docs/poc.md) |
| Branch checks | Checks a branch's changes, as a pull request shows them, against a document set before merging. Results stay separate from the audit | [Branch checks](docs/branch-check.md) |
| Schedules | Cron for matrices, SCA, scanners, entry point maps, hunts, document and branch checks and free-form tasks, with token limits and history | [Schedules](docs/schedules.md) |
| Freshness | Each verdict stores its commit and evidence files. A commit that touches them marks the verdict `stale` | [Concepts](docs/concepts.md#freshness-stale) |
| Service and CLI | A single Linux executable without a window; the CLI covers the same operations as the GUI | [Service and CLI](docs/service.md) |
| Choice of agent | Claude Code or pi, for the whole app, a project, a role or a module | [Agents](docs/agents.md) |
| History | Append-only runs with commit, configuration snapshot, session id, tokens and cost. Any session reopens in the built-in terminal | [Queue and sessions](docs/queue-and-sessions.md) |

## How it works

- Background runs use `claude -p --output-format stream-json` or `pi --mode json` in a `git worktree` on a pinned commit, so the working tree stays untouched.
- Each run gets its own token for the MCP server. The server knows the role and scope, and refuses writes outside the scope.
- Role permissions are written once, in Claude Code syntax. For pi, the aiegis extension enforces them on each tool call.
- The agent, role prompts, permissions, models, effort, scanners and limits live in YAML and Markdown files, resolved through the cascade `global → project → role → module → matrix → item`.
- Data lives in `~/.aiegis/` (global settings), `<repo>/.aiegis/` (project settings, committed) and the app's data directory (`db.sqlite`, documents, worktrees).

See [Concepts](docs/concepts.md), [Configuration](docs/configuration.md) and [Security](docs/security.md).

## Screenshots

The screenshots follow one audit of `acme-shop`, a small Express API with planted flaws, in the order the work goes.

| | |
|---|---|
| ![Modules with the hunt coverage of a module](docs/screenshots/hunt.png) | ![Entry point map with a call chain](docs/screenshots/entry-points.png) |
| 1. [Modules](docs/modules.md) and the vulnerability hunt | 2. [Entry points](docs/entry-points.md) of a module, compared with the previous map |
| ![Review of a new document version](docs/screenshots/document-review.png) | ![Token estimate before a verdict run](docs/screenshots/matrix-estimate.png) |
| 3. [Requirements](docs/documents.md) extracted with quotes, reviewed by a person | 4. Each [matrix](docs/matrix.md) run starts with a token estimate |
| ![A finding with independent verification](docs/screenshots/finding.png) | ![PoC result: reproduced](docs/screenshots/poc.png) |
| 5. A [finding](docs/findings.md) with its data flow and a second-opinion check | 6. The [PoC tester](docs/poc.md) reproduced it against a test instance |
| ![Dependency reachability](docs/screenshots/sca-item.png) | ![Scanner signals](docs/screenshots/signals.png) |
| 7. [SCA](docs/sca.md): reachability of a vulnerable package | 8. [Signals](docs/signals.md) from Semgrep, Gitleaks and Trivy |
| ![A branch check](docs/screenshots/branch-check.png) | ![A proposed new edition of a document](docs/screenshots/document-proposal.png) |
| 9. A [branch check](docs/branch-check.md) before merge | 10. The [document refresher](docs/document-refresher.md) found a new edition |
| ![Schedules](docs/screenshots/schedules.png) | ![A resumed agent session in the terminal](docs/screenshots/terminal.png) |
| 11. [Schedules](docs/schedules.md) with firing history | 12. Any run's session reopens in the [terminal](docs/queue-and-sessions.md#terminal-panel) |

## Install

You need:

- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), installed and logged in (`claude` on `PATH`), which is the default agent. Or [pi](https://pi.dev) (`npm install -g @earendil-works/pi-coding-agent`, `pi` on `PATH`, a provider configured in pi) with `agent: pi` in `~/.aiegis/config.yaml`. See [Agents](docs/agents.md).
- `git`.
- Optional: `semgrep`, `gitleaks`, `trivy` on `PATH`. A missing scanner is skipped.

Builds are on the [releases page](https://github.com/seelentov/aiegis/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `aiegis-<version>-mac-arm64.dmg` |
| Windows x64 | `aiegis-<version>-win-x64.exe` |
| Linux x64 | `aiegis-<version>-linux-x86_64.AppImage`, `.deb` |
| Linux x64, arm64: [service without a window](docs/service.md) | `aiegis-<version>-linux-x64`, `aiegis-<version>-linux-arm64` |

Builds are not signed. On macOS, right-click the app and choose **Open** the first time, or run `xattr -dr com.apple.quarantine /Applications/aiegis.app`.

### From source

```bash
git clone https://github.com/seelentov/aiegis.git
cd aiegis
npm install
npm run setup      # rebuilds node-pty for Electron
npm start
```

Then continue with [Getting started](docs/getting-started.md).

## Documentation

- Start: [Getting started](docs/getting-started.md) · [Concepts](docs/concepts.md) · [Interface](docs/interface.md)
- Audit: [Matrix](docs/matrix.md) · [Findings](docs/findings.md) · [SCA](docs/sca.md) · [Signals](docs/signals.md) · [Entry points](docs/entry-points.md) · [PoC tester](docs/poc.md) · [Branch checks](docs/branch-check.md)
- Sources: [Modules](docs/modules.md) · [Documents](docs/documents.md) · [Document refresher](docs/document-refresher.md)
- Automation: [Schedules](docs/schedules.md) · [Queue and sessions](docs/queue-and-sessions.md) · [Service and CLI](docs/service.md) · [CLI reference](docs/cli.md)
- Reference: [Configuration](docs/configuration.md) · [Agents](docs/agents.md) · [MCP tools](docs/mcp.md) · [Security](docs/security.md) · [Data and logs](docs/data-and-logs.md)

## Development

```bash
npm run typecheck     # TypeScript
npm test              # unit tests, no AI calls
npm run kit           # page with every UI control and state (macOS: opens it in the browser)
npm run dist          # installer for the current OS, in release/
npm run dist:service  # the Linux service executable, on Node 24
```

[GitHub Actions](.github/workflows/release.yml) builds the release for all platforms when a release is published.

## Contributing

Issues and pull requests are accepted: bug reports, scanners, agent integrations, prompt changes, translations, docs. The checks a pull request must pass are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Methodology fragments in `defaults/instructions/methodology/` are adapted from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT, © Cloudflare, Inc.).
