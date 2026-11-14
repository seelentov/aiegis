# Findings

A finding is one security problem, stored apart from the checks that produced it. A finding links to any number of matrix cells and SCA items.

![The Findings tab](screenshots/findings.png)

## Lifecycle

```text
suspected → verified | false_positive | accepted_risk | fixed
```

Agents create findings as `suspected` and can't change a status; only a person can. `false_positive` and `accepted_risk` require a reason. A successful [PoC](poc.md) and an [independent verification](#independent-verification) are inputs to that decision; neither sets the status.

The finding record is immutable. Its state is derived from an append-only event list: `created`, `status`, `link`, `merged`.

## Fields

Title, description, severity, CWE, entry point, files, data flow, recommendation, module. Severity uses one scale for findings and signals.

The agent that creates a finding fills in the data flow: ordered steps from the point where attacker input enters to the sink, each with `file:line` and a note. It stays empty for flaws that aren't flows (a missing check, say) and for manual findings. [Independent verification](#independent-verification) checks each step; the [PoC tester](poc.md) and fix sessions get it in their prompts.

## Where findings come from

- Matrix verdicts (`create_finding`, `link_finding`).
- SCA reachability (`create_sca_finding`, `link_sca_finding`).
- [Vulnerability hunt](modules.md#vulnerability-hunt) (`create_hunt_finding`), with no requirement attached.
- Manual: **Finding** on a cell or an SCA item.

## Deduplication

An agent must call `find_similar` before creating a finding. It scores live findings: same entry point +3, same CWE +2, shared files up to +3. Findings scoring 3 or more are candidates; at most `findings.similar_limit` are returned. `create_finding` is refused without the `check_id` that `find_similar` issued to the run. If a candidate describes the same flaw, the agent links to it instead of creating a new one.

Manual merge is in the **Similar (manual merge)** section: **Into current** or **Current into it**. The source becomes a link to the target and its cells move to the target; links to a merged finding resolve to the target. Merged findings are hidden unless **show merged** is ticked.

## The table

Columns: picker, finding, severity, status, verification, CWE, module, document, links (number of cells), created. Filters behave like all [table filters](interface.md#tables); the document filter matches through the requirements of linked cells.

Any unmerged finding can be ticked. **Pick all** ticks every finding that passes the filters, across pages; **Clear the picks** unticks them. With findings ticked, a second toolbar sets one status with one reason on all of them in a single transaction: if one can't change (merged in the meantime, or a required reason is missing), none changes. **Verify** applies only to ticked `suspected` findings, **Check fix** only to ticked stale ones.

## Details

![The details of a finding with its independent verification](screenshots/finding.png)

| Section or button | Content |
|---|---|
| **Status** | Current status, **Change the status** |
| Body | Description, recommendation, entry point, files, data flow |
| **Cells** | Rechecks linked matrix cells after an estimate |
| **Matrix cells**, **Vulnerable dependencies (SCA)** | Linked cells and SCA items |
| **Similar (manual merge)** | Merge candidates |
| [Independent verification](#independent-verification) | Results, **Verify** |
| [PoC tester](poc.md) | Results, **Environment** |
| **Sessions** | Agent sessions that touched the finding; each can be reopened |
| **History** | Events |
| **Fix** | Opens a [fix session](#fix-sessions) |

## Independent verification

An agent asked to refute its own finding in the same session tends to defend it. **Verify** starts a separate background session of the role `finding-verify` whose only goal is to refute a `suspected` finding. Unlike the [PoC tester](poc.md), it needs no running environment.

Input is the finding's claim and code locations, passed as JSON marked as data. The session doesn't receive the recommendation, the notes on code references, the author or the run. Its MCP token allows only `whoami` and `set_finding_verification`, so verdict reasons, runs and other findings are unavailable; file access is limited to its checkout, which excludes the original session's transcript.

The checkout is a read-only worktree at the commit of the session that created the finding, or at the current HEAD for a manual finding. The session only reads source: no exploit code, no execution, no network probes. It records one outcome with a reason. Outcomes are append-only; the **Verification** column shows the latest. The finding's status stays as it was.

| Outcome | Meaning | Code references |
|---|---|---|
| `refuted` | The code shows that the claimed fact or the claimed effect is false | Required |
| `confirmed` | It tried to refute the claim and could not. A true claim that matters less than it says is still `confirmed`, and the reason says why the impact is lower | Required |
| `undetermined` | The repository does not decide it (deployment, proxy, identity provider), or the session could not finish. The reason names the deciding fact | Optional |

Read the reason before setting a status: `confirmed` with a note on low impact can justify `accepted_risk` rather than `verified`.

Batch verification: tick findings (**Pick suspected** ticks the filtered `suspected` ones), press **Verify** in the toolbar, confirm the estimate. One session per finding. The estimate is the average of the role's last `findings.verify_estimate_history_runs` runs, or `findings.verify_estimate_tokens` without history. With the default model and effort a session typically takes 12k–25k billable tokens.

**Verify** on a single finding starts immediately, without an estimate, as **PoC** does.

The outcome is a second opinion from a model, not a proof.

Model, effort, prompts and permissions come from the role and the task `finding_verify`, see [Configuration](configuration.md). The provider's safety filter can stop a run, see [Provider safety filters](security.md#provider-safety-filters).

## Checking a fix

Each live `suspected` or `verified` finding is compared with HEAD without AI: `git diff` from the finding's commit over its files, plus the package manifest for a dependency finding. If any of them changed, the table marks the finding stale and its details show **Check fix**.

**Check fix** runs one background session per finding, in the read-only role `finding-verify`, in a worktree at HEAD, after an estimate.

| Outcome | Code references | Next comparison starts from |
|---|---|---|
| `closed` | Required | The checked commit |
| `not closed` | Required | The checked commit |
| `undetermined` | Optional | Unchanged; the finding stays stale |

Outcomes are append-only and don't change the status; `fixed` is set by a person. Old manual findings without a recorded commit always show as stale. A fix made only in other files doesn't mark the finding stale, so after a [fix session](#fix-sessions) the app offers the check regardless.

Batch check: tick findings (**Pick stale** ticks the filtered stale ones), press **Check fix** in the toolbar, confirm the estimate. For periodic checks use the [schedule action](schedules.md) `fix_verify`.

Model, effort and permissions come from the role, the prompt from the task `fix_verify`, and the estimate from the `findings.verify_estimate_*` settings.

## Fix sessions

**Fix** starts an interactive session of the role `assistant` in the working directory (not a worktree) with the finding as the initial prompt (task `fix`). The session edits your code; review its changes. If a commit appears after the session ends, the app offers to [check the fix](#checking-a-fix) and to [recheck affected cells](matrix.md#rechecking-after-a-fix).

## Command line

```bash
aiegis finding list
aiegis finding show <finding>
aiegis finding status <finding> false_positive 'Only reachable by administrators'
aiegis finding bulk-status accepted_risk 'Internal tool, behind VPN' <finding...>
aiegis finding verify-estimate <finding...>
aiegis finding verify <finding...>
aiegis finding fix-state
aiegis finding fix-estimate <finding...>
aiegis finding fix-check <finding...>
aiegis finding merge <source> <target>
aiegis finding create <cell> --title '...' --description '...' --severity high --cwe CWE-639 --evidence api/orders.js:12
aiegis finding link <finding> <cell>
aiegis finding poc <finding>
```

Fix sessions need a terminal and exist only in the desktop app.
