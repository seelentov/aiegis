# Entry points

An entry point map lists where data enters a module (routes, handlers, consumers, commands), what guards each entry and where the input flows. Verdict sessions, hunts and document plans read it through MCP.

![The Entry points tab with an expanded call chain](screenshots/entry-points.png)

## What a record holds

| Field | Meaning |
|---|---|
| Type | `http`, `grpc`, `graphql`, `queue`, `cron`, `cli`, `websocket` or `plugin` |
| Method, route or name | For example `GET /api/orders/:id`. Type, method and name form the key of the record |
| Handler | `file:line`, relative to the repository root |
| Middleware | The middleware applied to it |
| Authorization | The requirements, as text |
| Parameters | Name, source, and optionally a type |
| Call chain | `file` and `function` steps, optionally with a line, down to sinks, which are marked |
| Notes | Free text |

`http` covers only routes the module registers itself. `plugin` covers methods a platform or framework calls with user data: SPI implementations, listeners, hooks. A `plugin` name has the form `Interface.method`; its notes name the platform flow that calls it and the input it receives.

File paths must exist in the run's checkout.

## Building a map

**Build module map** on this tab and **Build map** / **Map all** on **Modules** queue one session per module, role `entry-points`, with the module's cascade level. A module with a map job already queued or running is skipped.

## Versions

Each map is a snapshot bound to a commit. A successful run marks its snapshot `complete` and read-only; a failed run leaves an incomplete snapshot, still visible in the version list. The current map is the latest `complete` snapshot. Background runs build a map from scratch, while an interactive continuation starts from a copy of the parent snapshot and becomes `complete` when the session exits.

The selectors pick a module and a version; **Search all columns** filters the table. Each entry is compared with the previous complete version and marked `new`, `changed`, `removed` or `unchanged`. An expanded row shows middleware, parameters and the call chain; a click on a handler or chain step opens it in VS Code.

**Modules** marks a map `stale` when the module's files or call chain files change after the snapshot, see [freshness](concepts.md#freshness-stale).

## Command line

```bash
aiegis entry-points build <module>
aiegis entry-points build-all
aiegis entry-points show <module> [--snapshot <id>]
```

The schedule action `entry_points` rebuilds maps on cron, see [Schedules](schedules.md).
