# Documents and requirements

Documents are the standards and guidelines the audit checks against. A document version reaches the matrix only after a person approves its requirements.

![The Documents tab: a set with a pending new edition](screenshots/documents.png)

Sources of documents: [uploaded files](#uploading-a-document) (MD, PDF, DOCX), [documents written by AI](#security-documents-written-by-ai) from the code, and the [document refresher](document-refresher.md), which finds new editions and new documents at saved links.

## Uploading a document

**Upload document** takes a title (default: the file name) and an optional set. **Upload a new version** adds a version to an existing document. Uploading is blocked while the document has an unfinished version; a file identical to the current approved version is rejected.

| Format | How the text is read | Are quotes checked? |
|---|---|---|
| MD | As is | Yes |
| DOCX | Converted to text | Yes |
| PDF | An agent (role `doc-text`) reads it into text once | Against that reading; the version is marked as read by AI, so compare important items with the file |
| PDF that could not be read | The extraction agent reads the PDF directly | No; the review shows a warning |

## Extraction

An agent (role `requirements`) records each requirement with a key, text, section, clause and a verbatim quote. The key is the document's own id, or a generated `R-NNN` if there is none. A quote that isn't found in the text is rejected; the comparison ignores case, whitespace, quote marks and Markdown markup. The agent also records the document's own metadata (name, number, date, edition), only as printed: missing values stay empty.

Version states:

| State | Meaning | What you can do |
|---|---|---|
| `extracting` | The agent is working | Watch the items appear |
| `review` | Waiting for review | Review, approve |
| `failed` | The run failed | **Extract again**; review existing items; discard |
| `approved` | Read-only, in force | Edit citation details only |
| `discarded` | Abandoned | Nothing |

## Document status and actions

The list groups documents by [set](document-refresher.md#sets). A row shows the current version, item count, pending proposals and the last check's status (`current`, `change found`, `could not check`, `not checked`) with its date. Document and version actions: open the source file, open the extraction session, open the review.

## Review

![Review of a new version: a changed and a new item still pending](screenshots/document-review.png)

Review is mandatory. The filter shows all, pending, or new and changed items. Per item: **Accept**, **Reject**, **Edit**; for the version: **Accept all**, **Add an item manually**. Added and edited items get the author `human` and are accepted immediately.

**Approve** requires every item reviewed and at least one accepted. An approved version and its items are immutable, except for citation details (name, number, date, edition): they identify the version rather than state requirements, so they stay editable.

## A new version of a document

The review compares a new version with the previous approved one, by key:

| Mark | Meaning |
|---|---|
| `new` | Not in the previous version |
| `changed` | The normalized text differs |
| `removed` | No longer present |
| unmarked | Unchanged |

An accepted item whose quote still occurs verbatim in a new MD or DOCX file is carried over without AI: same key, text and section, author `auto`, already accepted. The agent extracts only the remaining text. Carry-over happens once at import, so **Extract again** doesn't overwrite manual edits. Carried items can still be rejected or edited.

Carry-over is only as precise as the quote: if a quote covers part of a sentence and another part of that sentence changed, the item is carried as unchanged. The extraction prompt asks for whole-sentence quotes for this reason. Unreadable PDFs get no carry-over.

After approval:

- a changed requirement makes its matrix verdicts `stale`;
- a removed requirement leaves the matrices, and the history of its cells stays.

## Citations

Each requirement has a citation string built from the version's name, number, date, edition and the item's clause, for referencing it in tickets. Unknown parts and generated `R-…` keys are omitted. Citations appear in cell and finding details, fix sessions, probable repeats and `aiegis doc requirements`. **Change how this version is cited** or `aiegis doc info` corrects them.

## Security documents written by AI

**Write documents** covers the whole application in two steps. Optional hints (focus, standards to follow, document language) apply to both.

1. Plan (task `doc_plan`, role `doc-author`, read-only). The agent reads modules, entry point maps, build and security configuration and records a plan. Each document covers a security domain (authentication, authorization, input handling), not a module, since the matrix already crosses every requirement with every module. The plan is rejected if it leaves a live module uncovered or changes a generated document's key prefix.
2. Writing (task `doc_write`), one session per planned document. The app validates the fixed format:

   ```markdown
   # Title

   A paragraph with the scope.

   ## Section

   - **AUTH-1** One requirement sentence.
     An indented line adds context for people.
   ```

A written document becomes a new version without an extraction run: items are parsed from the lines. It then goes through the normal review. Sections become matrix groups; the plan targets 3–10 requirements per section. All documents of a plan go into one set named by the agent.

Generated documents carry the label `AI · PREFIX` with the scope in a tooltip. **Rewrite** queues a new version with new hints: unchanged requirements are copied verbatim and keep their history, new ones get higher numbers. A document with an unapproved version is skipped until that version is approved or discarded.

Document generation has no estimate.

## Probable repeats

**Probable repeats between documents** lists requirement pairs from different documents that share at least `doc_refresh.repeat_min_similarity` of their words, with source links. It merges nothing.

## Out of force

**Out of force** (with a reason) removes a document's requirements from matrices and checks; history and findings remain. **Back into force** restores it, and whatever changed in the meantime shows as `stale` by the usual rules. Documents are never deleted.

A single item can be taken out of force while its document stays in force and under refresher checks: **Out of force** on the item's row in an approved version, with a reason. The item disappears from matrices and branch checks, past checks included; its history remains. The decision is tied to the requirement key, so it carries over to new versions. **Back into force** on the row reverts it.

## New matrix

**New matrix** on an approved version opens the [matrix form](matrix.md#creating-a-matrix) with the document preselected.

## Command line

```bash
aiegis doc import ./guide.md --title 'Secure coding guideline'
aiegis doc list
aiegis doc show <version>
aiegis doc review <version> accepted <item>...
aiegis doc item <version> --text '...' --section 'Access control' --key AC-9
aiegis doc info <version> --name '...' --number '...' --date '...' --edition '...'
aiegis doc approve <version>
aiegis doc state <version> review       # or: discarded
aiegis doc retry <version>
aiegis doc plan --hint 'Focus on the payment flow'
aiegis doc rewrite <document> --hint '...'
aiegis doc retire <document> 'Replaced by the 2026 edition'
aiegis doc restore <document>
aiegis doc item-retire 'Not checkable in code' <requirement>...
aiegis doc item-restore <requirement>...
aiegis doc repeats
aiegis doc requirements
```

See the [CLI reference](cli.md#doc).
