# aiegis documentation

aiegis is a desktop app and a Linux service that runs AppSec audits with a local coding agent. Installation and the first audit are in [Getting started](getting-started.md).

Screenshots show `acme-shop`, a small Node.js/Express demo API with planted vulnerabilities: two modules, a guideline of six requirements, Claude Haiku with low effort for every role. The data on them comes from real agent runs; the whole demo cost about $0.35.

## Start

- [Getting started](getting-started.md): install, first start, a first audit
- [Concepts](concepts.md): data model, roles, worktrees, verdict rules, `stale`, history
- [Interface](interface.md): layout, setup guide, shortcuts, projects, tables, notifications

## Audit

- [Matrix](matrix.md): requirements × modules, triage, verdicts, estimates
- [Findings](findings.md): lifecycle, deduplication, data flow, merging, independent verification, fix sessions
- [SCA](sca.md): dependency inventory, prefilter, reachability
- [Signals](signals.md): scanners, signals, suppressions
- [Entry points](entry-points.md): maps, versions, comparison
- [PoC tester](poc.md): test environment, env-setup, isolation
- [Branch checks](branch-check.md): a branch against a document set before it merges

## Sources

- [Modules](modules.md): globs, AI markup, history, vulnerability hunt
- [Documents and requirements](documents.md): upload, extraction, review, versions, documents written by AI
- [Document refresher](document-refresher.md): sets, checks, proposals, network limits

## Automation

- [Schedules](schedules.md): actions on cron
- [Queue and sessions](queue-and-sessions.md): jobs, runs, limits, the Sessions tab, interactive sessions, terminal
- [Service and CLI](service.md): running without a window, systemd
- [CLI reference](cli.md): every command

## Reference

- [Configuration](configuration.md): the cascade, every setting, tasks, roles
- [Agents](agents.md): Claude Code or pi
- [MCP tools](mcp.md): what agents can call
- [Security](security.md): protections and what they do not cover
- [Data and logs](data-and-logs.md): locations, logs, troubleshooting
