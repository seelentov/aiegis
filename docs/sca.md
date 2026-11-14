# SCA

SCA decides whether a module uses a vulnerable dependency in a way that triggers the vulnerability. An SCA item is module × package@version × vulnerability.

![The SCA tab: inventories per module and vulnerable dependencies](screenshots/sca.png)

## Inventory

An agent (role `sca-inventory`) builds each module's list of vulnerable dependencies. The app doesn't assume a language or tool; the agent chooses, for example `npm audit`, Gradle with lock files, `trivy`, `osv-scanner`, `grype` or `govulncheck`. Extra inputs:

- uploaded lock files, SBOMs and scanner reports, per module or per project, used by the next run;
- dependency CVEs from [scanners](signals.md) as hints, up to `sca.scanner_hints_limit`.

**Inventory** at the top runs for all modules or the module in the selector; the row button reruns one module. Build tools write to the checkout, so the inventory gets its own worktree; the agent keeps its files in `.aiegis-sca/<job-id>/`.

### Validation of reported packages

`add_vulnerable_package` is accepted only when:

- its report is a file inside the run's directory, within `sca.report_max_mb`;
- the report contains the package name (or its artifact without the group), the version, and each vulnerability or an alias of it;
- the manifest exists.

The report is stored and linked from the item. A run must end with `set_inventory_summary`: ecosystems, tools, number of dependencies checked, and the manifests the result depends on. Without it the run ends with an error and **Retry** continues it. A summary with no tools is rejected; manifests must be tracked by git. When dependencies can't be resolved the agent writes no summary, so an unfinished inventory can't pass as clean.

### Building elsewhere

The role's allowlist covers common build and audit tools; package caches are granted through `permissions.dirs`. To resolve dependencies on a build server, extend the role in the project configuration:

```yaml
roles:
  sca-inventory:
    permissions:
      allow: ["Bash(ssh build-host:*)"]
    instructions: "Resolve dependencies on build-host, then scan the copied lock file locally."
```

> Building runs the project's build scripts on your machine. Run the inventory only on trusted repositories or restrict this role. See [Security](security.md#what-is-not-isolated).

## Prefilter

Before calling the agent, the app greps the module's files at `HEAD` for each package's import names, matching on identifier boundaries. The inventory agent supplies the names: Java packages, the npm name, a Python module. Binary files and files over `sca.prefilter_max_file_kb` are skipped.

| Prefilter result | Outcome |
|---|---|
| No references | `not_reachable`, author `auto` |
| References found | Passed into the reachability prompt |
| No import names known | Left to the agent |

## Reachability

**Reachability** (unchecked items), **Stale** (stale items) and **Recheck** on an item start a run, for all modules or the one in the top selector. The estimate shows items the prefilter closes, AI sessions (one per module × package) and tokens, based on the role's last `sca.estimate_history_runs` runs or `sca.estimate_tokens_per_package`. Items already queued are skipped.

| Verdict | Needs |
|---|---|
| `reachable` | Evidence and a linked finding |
| `not_reachable` | Evidence of how the package is used |
| `needs_human` | A reason |

Verdicts are saved per vulnerability; **Retry** takes only vulnerabilities without a verdict.

## Freshness

A verdict becomes `stale` when its evidence files, the package manifest or the finding's files change. An inventory becomes `stale` when a manifest named in its summary changes. A new inventory produces a new set of items, and existing verdicts carry over by module × package × vulnerability.

## The tab

| Section | Content |
|---|---|
| **Modules** | Inventory status, commit, `stale` flag, tools, summary, last run's error, rerun button |
| **Uploaded dependency files** | Upload or exclude files. Files are never deleted; **show excluded** lists excluded ones |
| **Vulnerable dependencies** | Filters: module, status, `stale` only, severity, direct only, text search |

![The details of an SCA item](screenshots/sca-item.png)

Item details: vulnerability, fixed version, package, manifest, import names, references in the module, the tool report, verdict and evidence, findings, **Link the finding to the item**, manual **Verdict** and **Finding**, history, effective configuration. Findings list their linked SCA items too.

## Command line

```bash
aiegis sca add-input ./package-lock.json --module api --note 'Production lock file'
aiegis sca remove-input <input>
aiegis sca inventory --module api
aiegis sca show
aiegis sca estimate --scope pending
aiegis sca run --scope stale
aiegis sca item <item>
aiegis sca verdict <item> not_reachable 'Only used in tests' --evidence test/setup.js:3
aiegis sca finding <item> --title '...' --description '...' --severity high
aiegis sca link <finding> <item>
aiegis sca report <report>
```
