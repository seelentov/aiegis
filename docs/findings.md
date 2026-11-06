# Findings

A finding is one security problem, separate from the checks that found it. One finding can link to many matrix cells and SCA items.

![The Findings tab](screenshots/findings.png)

## Lifecycle

```text
suspected → verified | false_positive | accepted_risk | fixed
```

Agents create findings as `suspected` and never change a status. Only people do, and `false_positive` and `accepted_risk` require a reason. A successful [PoC](poc.md) suggests `verified`, but you set it.

A finding itself cannot change; its state comes from an append-only list of events (`created`, `status`, `link`, `merged`).

## Fields

Title, description, severity, CWE, entry point, files, recommendation, module. Severity uses one scale for findings and signals.

## Where findings come from

- Matrix verdicts (`create_finding`, `link_finding`).
- SCA reachability (`create_sca_finding`, `link_sca_finding`).
- Manual input: **Finding** on a cell or an SCA item.

## Deduplication

Before creating a finding, an agent must call `find_similar`. It ranks live findings: the same entry point scores +3, the same CWE +2, shared files up to +3. A finding scoring at least 3 is a candidate, and up to `findings.similar_limit` are returned. `create_finding` is refused without the `check_id` issued to that run, and if a candidate is the same flaw, the agent links to it instead.

You can also merge by hand. The **Similar (manual merge)** section offers **Into current** and **Current into it**: the source becomes a link to the target, and its cells move to the target. Links to a merged finding go to its target. Merged findings are hidden unless you tick **show merged**.

## The table

Columns: finding, severity, status, CWE, module, document, links (the number of cells) and created. The filters work like all [table filters](interface.md#tables). The document filter goes through the requirements of the linked cells.

## Details

![The details of a finding with the PoC result](screenshots/finding.png)

- **Status** with **Change the status**.
- Description, recommendation, entry point and files.
- **Cells**, which rechecks the linked matrix cells after an estimate.
- **Matrix cells** and **Vulnerable dependencies (SCA)** linked to the finding.
- **Similar (manual merge)**.
- **[PoC tester](poc.md)** with **Environment**.
- **Sessions**: the agent sessions behind the finding; any of them can be reopened.
- **History**: its events.
- **Fix**, which opens a [fix session](#fix-sessions).

## Fix sessions

**Fix** starts an interactive session of the role `assistant` in your working directory, not a worktree, with the finding as the initial prompt (task `fix`). It can edit your code, so review the result. When a commit appears after the session ends, the app [offers to recheck](matrix.md#rechecking-after-a-fix). This is a normal agent session; there is no separate fix generator.

## Command line

```bash
aiegis finding list
aiegis finding show <finding>
aiegis finding status <finding> false_positive 'Only reachable by administrators'
aiegis finding merge <source> <target>
aiegis finding create <cell> --title '...' --description '...' --severity high --cwe CWE-639 --evidence api/orders.js:12
aiegis finding link <finding> <cell>
aiegis finding poc <finding>
```

Fix sessions need a terminal, so they exist only in the desktop app.
