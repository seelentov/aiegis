# aiegis documentation

aiegis is a desktop app and a Linux service for AppSec audits on top of a local coding agent. New here? Start with [Getting started](getting-started.md).

Screenshots show a small demo API (Node.js/Express with deliberate vulnerabilities): two modules, a six-item guideline, inexpensive models. All the data in them comes from real agent runs.

## Start

- [Getting started](getting-started.md): install, first start, a first audit
- [Concepts](concepts.md): data model, roles, worktrees, verdict rules, `stale`, history
- [Interface](interface.md): layout, shortcuts, projects, tables, notifications

## Audit

- [Matrix](matrix.md): requirements × modules, triage, verdicts, estimates
- [Findings](findings.md): lifecycle, deduplication, merging, independent verification, fix sessions
- [SCA](sca.md): dependency inventory, prefilter, reachability
- [Signals](signals.md): scanners, signals, suppressions
- [Entry points](entry-points.md): maps, versions, comparison
- [PoC tester](poc.md): test environment, env-setup, isolation
- [Branch checks](branch-check.md): a branch against a document set before it merges

## Sources

- [Modules](modules.md): globs, AI markup, history
- [Documents and requirements](documents.md): upload, extraction, review, versions, documents written by AI
- [Document refresher](document-refresher.md): sets, checks, proposals, network limits

## Automation

- [Schedules](schedules.md): actions on cron
- [Queue and sessions](queue-and-sessions.md): jobs, runs, limits, interactive sessions, terminal
- [Service and CLI](service.md): running without a window, systemd
- [CLI reference](cli.md): every command

## Reference

- [Configuration](configuration.md): the cascade, every setting, tasks, roles
- [Agents](agents.md): Claude Code or pi
- [MCP tools](mcp.md): what agents can call
- [Security](security.md): protections and what they do not cover
- [Data and logs](data-and-logs.md): locations, logs, troubleshooting
