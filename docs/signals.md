# Signals

Signals are scanner results. The app runs the scanners itself, without AI, and gives the results to agents as hints to verify. They are not a complete list: agents look for IDOR, privilege problems and business logic flaws themselves.

![The Signals tab](screenshots/signals.png)

## Scanners

Scanners are settings, not code. Three come configured:

| Scanner | Default scan | Finds |
|---|---|---|
| `semgrep` | `scan --config p/default` | SAST |
| `gitleaks` | `dir` | Secrets |
| `trivy` | `fs`, scanners `vuln,secret,misconfig` | Dependency CVEs, secrets, misconfigurations |

See [`scanners`](configuration.md#scanners) to change arguments or add your own rules.

The panel at the top shows each scanner's availability and version. Enabled scanners are checked at startup with `version_args`, and **Check scanner availability again** repeats the check. An unavailable scanner produces one notification and is skipped when scanning.

## Scanning

- **Modules** scans the files of all modules.
- **Repository** scans the whole repository.
- Matrix verdicts queue missing scans of their modules when `signals.auto_scan` is on.

Each scan is a queue job that runs in the commit's worktree, without AI. Scanned paths are the smallest set of static prefixes of the modules' globs. Results are cached by commit: a scan is not queued if a `complete` scan of the same scanner covers those paths on that commit or an equivalent job is active.

Raw reports can contain secrets, so they go to a temporary `0700` directory and are deleted after normalization. A scan that crashes, times out or is cancelled is `failed`, and its results are not used.

The **Scanner runs** sub-tab lists scans with the scanner, commit, paths, status, tool version, command lines, error and warnings. Non-fatal tool problems, such as files semgrep could not parse, are kept as warnings on a `complete` scan. `get_signals` tells the agent how many warnings touch the module's files, so that it checks those files itself.

![The Scanner runs sub-tab](screenshots/scanner-runs.png)

## What a signal holds

| Field | Meaning |
|---|---|
| Kind | `sast`, `secret`, `misconfig`, `vuln` |
| Scanner, rule, severity | Severity uses the same scale as findings |
| File and lines | From the repository root |
| CWE, tags, message, snippet | From the tool |
| Fingerprint | Stable between commits: rule + file + matched text, without the line number |

**Secrets are not stored.** Gitleaks matches are masked, semgrep `secrets.*` rules keep no snippet, and Trivy masks its own.

Semgrep rule ids do not depend on where a rule file sits on disk. By default, semgrep skips tests, vendored and minified files and honors `.semgrepignore`. To scan everything git tracks, add `--x-ignore-semgrepignore-files` to `scanners.semgrep.args`.

Dependency CVEs (`vuln`) are kept for [SCA](sca.md), not given to verdict sessions (`signals.exclude_kinds`).

## The Signals sub-tab

Choose a commit and filter by scanner, kind, module, severity or file. Signals in files that belong to no module are shown as `outside modules`. A commit other than `HEAD` is flagged, because lines in your editor may differ. **show suppressed** includes suppressed signals with their state. The details panel shows the scanner's data, the snippet, the scan and the suppressions, and offers **Suppress**.

## How agents read signals

`get_signals` takes a module and optionally a requirement, kind, scanner, minimum severity, file prefix and limit:

- for each scanner, it uses the scan covering the module on the run's commit, or else the newest one;
- it returns only the module's files, minus suppressed signals;
- an optional relevance filter applies per requirement key, using `signals.requirements`;
- it returns at most `signals.max_per_call` signals;
- the reply says which scanners did not scan the module, how many signals were suppressed or cut off, and that signals are hints;
- the same secret from several scanners comes back as one signal, and the others are listed in `also_reported_by`. Suppressing one suppresses the group. The tab still shows them separately.

A relevance entry looks like this. `rules` are regular expressions over rule ids, and any match counts:

```yaml
signals:
  requirements:
    AC-2: { kinds: [sast], cwe: [CWE-639, CWE-284], rules: ["idor|authz"] }
```

## Suppressions

![The Suppressions sub-tab](screenshots/suppressions.png)

A suppression hides noise before it reaches the agent. **show revoked** includes revoked ones in the list. It needs a reason, and records the author (the project's git `user.name <email>`, or else the OS user) and the commit. An expiry date is optional.

| Scope | Created from | Effect |
|---|---|---|
| Finding (`finding`) | A signal | That signal, by scanner and fingerprint |
| Rule × glob (`rule_glob`) | A signal; the globs must cover its file | A scanner's rule in those files |
| Item × module (`requirement_module`) | The **Suppressions** sub-tab | All signals in `get_signals` for that cell |

Suppressions are append-only. To change one, revoke it (once, with a reason) and create a new one.

| State at `HEAD` | Meaning |
|---|---|
| `active` | In force |
| `stale` | The code it depends on changed |
| `expired` | Past its date |
| `revoked` | Revoked |

A `stale` suppression does not filter by default (`suppressions.apply_stale: false`): the signal reaches the agent with its reason, marked `suppression_not_applied`. **Confirm** in its details re-confirms it at `HEAD` as a new record that replaces the old one.

The details show what it depends on and which files changed. Up to `suppressions.few_shot_limit` relevant suppressions also go into verdict prompts as examples, item × module first.

## Command line

```bash
aiegis scanner status --refresh
aiegis scanner run                         # all modules; --module <name>, --repository
aiegis scanner list
aiegis signal list --commit <sha>
aiegis signal show <signal>
aiegis suppression list
aiegis suppression create --scope finding --signal <id> --reason 'Test fixture'
aiegis suppression create --scope rule_glob --signal <id> --glob 'test/**' --reason 'Tests only'
aiegis suppression create --scope requirement_module --requirement <id> --module api --reason '...' --expires 2027-01-01
aiegis suppression revoke <suppression> 'The fixture is gone'
aiegis suppression renew <suppression> --expires 2027-06-01
```
