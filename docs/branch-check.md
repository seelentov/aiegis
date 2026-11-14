# Branch checks

A branch check reviews a branch before merge against a document set or a single document: whether its changes violate a requirement or introduce a vulnerability the requirements cover.

![A branch check and its verdicts](screenshots/branch-check.png)

## Running a check

1. Pick the **Target branch** (for example `main`) and the **Branch to check**; both lists are [searchable](interface.md#dropdown-lists).
2. Pick a **Set or document**.
3. **Check** opens the estimate; confirm to run.

The diff goes from the fork point (`git merge-base`) to the branch head, the same range a pull request shows; later commits on the target are excluded. A branch without changes is rejected.

Branches are read from local and remote-tracking refs. The app doesn't run `git fetch`; fetch by hand to see the latest state.

## What is checked

Accepted items of the current approved versions of the selected documents, excluding documents and items [out of force](documents.md#out-of-force). The check records the set's name and document versions at start, so later edits to the set don't change its result.

## Sessions

One session normally covers the whole check (task `diff_check`, role `diff-check`) in a worktree at the branch commit. All items and the diff go into the prompt, up to `diff_check.max_diff_kb_in_prompt` (default 1000 KB, roughly 450k tokens). A larger diff stays out of the prompt and the agent reads it piecemeal with `git diff`, which misses noticeably more.

Files matching `diff_check.prompt_exclude` (by default tests, styles, lock and generated files) are cut from the diff in the prompt but stay in the list of changed files for the agent to read when relevant.

The agent first lists security-relevant changes, then reads the code each one affects outside the diff: callers of a changed method, called methods, how a new operation is exposed. A candidate it can't trace to the end becomes `needs_human`.

The check splits into several sessions only above `diff_check.batch_size` items, because each session re-reads the whole diff. The diff itself is never split by files: that cost about 40% more without finding more.

A global config created by an older version keeps its old `max_diff_kb_in_prompt` (200); raise it by hand.

Verdicts are saved per item; **Retry** takes only items without a verdict.

## Verdicts

Statuses match the matrix:

| Status | Needs |
|---|---|
| `n/a` | A reason |
| `pass` | A reason and code references |
| `finding` | A reason, code references, a severity, and a reference to at least one changed file (deleted files count): code outside the diff isn't the branch's doing |
| `needs_human` | A reason and code references |

The agent writes verdicts in batches with `set_diff_verdicts`; invalid entries come back as `rejected`, the rest are saved.

## Separate from the audit

The branch isn't merged, so results stay in the check and don't reach **Findings** or the matrix. Each run is a new record; old ones remain. Branch checks have no manual verdicts.

## The tab

The top row holds **Target branch**, **Branch to check**, **Set or document** and **Check**. Below is the list of checks (branches, set or document, commit, changed file count, results, author, running sessions). Selecting a check lists its requirements with status, severity and reason; selecting a requirement opens details with branches, commit range, evidence and the verdict session.

## Estimate

The estimate uses the matrix panel with requirements in place of cells and no run history. Per session: items × `diff_check.estimate_tokens_per_requirement` + diff KB in the prompt × `diff_check.estimate_tokens_per_diff_kb`.

## On a schedule

The schedule action `diff_check` runs a check on cron. If the same fork point, commit and document versions were already checked, the firing ends as `nothing_to_do` without spending tokens. A manual run always checks again. See [Schedules](schedules.md).

## Safety

The diff is untrusted input; the role's prompt treats it as data, not instructions. The role has no write access, and `--output` (with abbreviations) is denied for `git log`, `git show` and `git diff` because it writes files. See [Security](security.md).

## Command line

```bash
aiegis diff branches
aiegis diff estimate --base main --head task-123 --set <id>
aiegis diff run --base main --head task-123 --set <id>     # or --document <id>
aiegis diff list
aiegis diff show <check>
```

`diff run` prints the estimate and asks for confirmation; `--yes` skips it.
