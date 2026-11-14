# Signals

Signals are scanner results. The app runs scanners without AI and passes the results to agents as hints to verify. Scanners miss IDOR, privilege and business logic flaws; agents look for those in the code.

![The Signals tab with the details of a Semgrep signal](screenshots/signals.png)

## Scanners

Scanners are defined in configuration. Defaults:

| Scanner | Default scan | Finds |
|---|---|---|
| `semgrep` | `scan --config p/default` | SAST |
| `gitleaks` | `dir` | Secrets |
| `trivy` | `fs`, scanners `vuln,secret,misconfig` | Dependency CVEs, secrets, misconfigurations |

Arguments and custom rules: [`scanners`](configuration.md#scanners).

The top panel shows each scanner's availability and version. Enabled scanners are probed at startup with `version_args`; **Check scanner availability again** repeats the probe. An unavailable scanner raises one notification and is skipped.

## Scanning

**Scan modules** scans the files of all modules, **Scan repository** the whole repository. With `signals.auto_scan` on, verdict runs queue missing scans of their modules.

Each scan is a queue job in the commit's worktree. Scanned paths are the minimal set of static prefixes of the modules' globs. Results are cached per commit: no scan is queued when a `complete` scan by the same scanner already covers those paths on that commit, or an equivalent job is active.

Raw reports may contain secrets; they're written to a temporary `0700` directory and deleted after normalization. A crashed, timed-out or cancelled scan is `failed` and its results are discarded.

The **Scanner runs** sub-tab lists scans: scanner, commit, paths, status, tool version, command lines, error, warnings. Non-fatal tool problems (files semgrep couldn't parse, for example) stay as warnings on a `complete` scan. `get_signals` reports how many warnings touch the module's files so the agent reviews those files by hand.

![The Scanner runs sub-tab](screenshots/scanner-runs.png)

## Importing SARIF

**Import SARIF** on the panel, or `aiegis scanner import`, loads a SARIF 2.1.0 report from any tool, such as CodeQL or an in-house SAST. A tool can also run from the app with `format: sarif` in [`scanners`](configuration.md#scanners). Imported results are ordinary signals: agents read them through `get_signals`; suppressions and deduplication apply. SARIF export isn't supported.

Each tool in a report becomes a scan named `sarif:<tool>` (for example `sarif:codeql`) on **Scanner runs**.

| Field | Mapping |
|---|---|
| Commit | From `versionControlProvenance`. If the report has none, `--commit` is required; a given commit that differs from the report's is rejected. The commit must exist in the repository |
| Paths | `file://`, percent-encoded and absolute paths, `uriBaseId` and `artifacts[]` references become repository-relative. A result whose file isn't in the repository at that commit is skipped with a warning; if nothing fits, the import is rejected. Absolute paths from another machine need **source root** (`--source-root`) unless the report sets `originalUriBaseIds` |
| Severity | First present of: `security-severity` score, a severity property, a tag such as `high`, `level`, the rule's default level. Fallback `medium`, `high` for secrets |
| CWE | Properties, tags such as `external/cwe/cwe-089`, rule relationships, `taxa` |
| Kind | `secret` or `misconfig` by rule, tags and CWE; `vuln` for rule ids starting with `CVE-` or `GHSA-`; otherwise `sast`. Imported `vuln` signals have no package data, so they feed neither verdict sessions nor SCA |
| Fingerprint | Rule + file + the tool's `fingerprints` or `partialFingerprints`, else the matched text or line |
| Code flows | Kept in the signal data; `get_signals` lists the locations of the first flow |

Results with `pass`, `notApplicable` or `baselineState: absent` are dropped. Results the tool suppressed are kept with the tag `suppressed-in-tool`, since a report can't create an aiegis suppression.

Reports are treated as untrusted input. The file is validated against the SARIF 2.1.0 shape and the [`sarif` limits](configuration.md#sarif); an invalid file is rejected entirely with an error naming the problem. Control and invisible characters are stripped from texts. Rule ids that can't be identifiers (spaces, over 200 characters) are replaced with a hash. Agents receive imported signals with `imported: true` and a note not to follow instructions inside them. No report text reaches a verdict prompt: a suppression of an imported signal appears there only as its file and your reason, without rule id or tool name.

Scans are append-only and a wrong import can't be deleted; suppress its results instead. A second import at the same commit adds to the earlier results.

## What a signal holds

| Field | Meaning |
|---|---|
| Kind | `sast`, `secret`, `misconfig`, `vuln` |
| Scanner, rule, severity | Severity uses the same scale as findings |
| File and lines | From the repository root |
| CWE, tags, message, snippet | From the tool |
| Fingerprint | Stable between commits: rule + file + matched text, without the line number |

Secret values aren't stored: Gitleaks matches are masked, semgrep `secrets.*` rules keep no snippet, Trivy masks its own output, imported SARIF secrets keep neither snippet nor code flows.

Semgrep rule ids don't depend on the rule file's location on disk. By default semgrep skips tests, vendored and minified files and honors `.semgrepignore`; to scan every tracked file, add `--x-ignore-semgrepignore-files` to `scanners.semgrep.args`.

Dependency CVEs (`vuln`) are kept for [SCA](sca.md), not given to verdict sessions (`signals.exclude_kinds`).

## The Signals sub-tab

Pick a commit and filter by scanner, kind, module, severity or file. Signals in files outside every module show as `outside modules`. A commit other than `HEAD` is flagged, since editor lines may differ. **show suppressed** adds suppressed signals with their state. Details: scanner data, snippet, scan, suppressions, **Suppress**.

## How agents read signals

`get_signals` takes a module and optional requirement, kind, scanner, minimum severity, file prefix and limit. For each scanner it uses the scan that covers the module at the run's commit, falling back to the newest one. It returns signals in the module's files minus suppressed ones, applies the per-requirement relevance filter from `signals.requirements`, and caps the result at `signals.max_per_call`.

The reply also lists scanners that didn't scan the module, counts of suppressed and truncated signals, and a reminder that signals are hints. One secret reported by several scanners comes back as one signal with the rest in `also_reported_by`; suppressing one suppresses the group. The tab still lists them separately.

Relevance entry; `rules` are regular expressions over rule ids, any match counts:

```yaml
signals:
  requirements:
    AC-2: { kinds: [sast], cwe: [CWE-639, CWE-284], rules: ["idor|authz"] }
```

## Suppressions

![The Suppressions sub-tab with a rule × glob suppression](screenshots/suppressions.png)

A suppression removes a signal from what the agent sees. It requires a reason and records the author (the project's git `user.name <email>`, else the OS user) and the commit; expiry is optional. **show revoked** adds revoked suppressions to the list.

| Scope | Created from | Effect |
|---|---|---|
| Finding (`finding`) | A signal | That signal, by scanner and fingerprint |
| Rule × glob (`rule_glob`) | A signal; the globs must cover its file | A scanner's rule in those files |
| Item × module (`requirement_module`) | The **Suppressions** sub-tab | All signals in `get_signals` for that cell |

Suppressions are append-only. To change one, revoke it (once, with a reason) and create another.

| State at `HEAD` | Meaning |
|---|---|
| `active` | In force |
| `stale` | The code it depends on changed |
| `expired` | Past its date |
| `revoked` | Revoked |

By default a `stale` suppression doesn't filter (`suppressions.apply_stale: false`): the signal reaches the agent with the suppression reason and `suppression_not_applied`. **Confirm** in the details re-issues it at `HEAD` as a new record replacing the old one.

Details list the suppression's dependencies and the changed files. Up to `suppressions.few_shot_limit` relevant suppressions go into verdict prompts as examples, requirement × module scope first.

## Command line

```bash
aiegis scanner status --refresh
aiegis scanner run                         # all modules; --module <name>, --repository
aiegis scanner list
aiegis scanner import codeql.sarif          # --commit <sha> if the report names none, --source-root <path>
aiegis signal list --commit <sha>
aiegis signal show <signal>
aiegis suppression list
aiegis suppression create --scope finding --signal <id> --reason 'Test fixture'
aiegis suppression create --scope rule_glob --signal <id> --glob 'test/**' --reason 'Tests only'
aiegis suppression create --scope requirement_module --requirement <id> --module api --reason '...' --expires 2027-01-01
aiegis suppression revoke <suppression> 'The fixture is gone'
aiegis suppression renew <suppression> --expires 2027-06-01
```
