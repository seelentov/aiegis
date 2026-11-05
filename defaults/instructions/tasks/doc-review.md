Check documents of project "{{project}}" against their sources. Target: {{target}}.

Set: {{set_name}}
What belongs to this set:
{{scope}}

This document's own pages (fetch these; you may follow links on the same hosts, for example to its file or an amending act):
{{links}}

The document in force (its files are in your current directory):
{{documents}}

Decide whether the document we hold is the current one, by reading it. Requirements are taken from it, and a missed change
is the worst outcome, so read rather than guess.

1. `fetch_url` each page; the whole text is in `text_file`, all links in `links_file`. Open the document's file and any act
   the page names as amending or replacing it.
2. Read our document: `text.md` if it is there, otherwise the whole PDF with `Read`, without the `pages` parameter.
3. Compare the texts, not only the dates. What a page states about its edition is evidence, and so is the text itself.
   Layout, line breaks, footnote marks and a conversion's small wording differences are not a new edition.
4. Decide one result:
   - same edition: `report_document_check` with status `current`, the `fetch_id`, what shows it and `edition`;
   - cannot be settled (page needs a login or JavaScript, no text to compare): status `unverifiable` and why;
   - it changed: `propose_document_change`, see below. Name in `reason` what changed, by clause.
5. Reply with a short summary.

`propose_document_change` kinds:
- `update`: a new edition of this document. `edition`, and the page or file holding the whole new text in `source_fetch_ids`
  (several pages in reading order if it is split).
- `update` from an amending act when no consolidated text exists: `restored_text` is our text with the act applied, word for
  word otherwise; `source_fetch_ids` holds the act. It is marked for the human.
- `replace`: another document replaces this one. `title`, `source_fetch_ids` of the new document, a `quote` stating it.
- `retire`: cancelled without replacement. A `quote` stating the cancellation. Absence from a page proves nothing.
- `link`: the document has no link of its own: `source_fetch_ids` with its page, `quote` naming it.
- `incomplete: true` with `update` or `replace`: the source shows only part of the new text. Nothing is stored, the human gets
  the notice and uploads the file. Never pass a partial text as the document.

For an HTML page pass `start_phrase` and `end_phrase`: the first and last words of the document on the page, copied from its
`text_file`. The app cuts the text itself, so it stays word for word.

`quote` is copied word for word from the text of a page you fetched in this run; `quote_fetch_id` names that page.
The app refuses a proposal it cannot verify; read the error and either fix the proposal or report the document instead.
