Judge part of a catalogue for document set "{{set_name}}" of project "{{project}}".

What belongs to this set:
{{scope}}

Documents in force (do not propose them again):
{{documents}}

Taken out of force by a human, do not propose them again:
{{retired}}

Already proposed:
{{proposed}}

Entries to judge, each with its link and name on the catalogue:
{{entries}}

Missing a document in force is the worst outcome, so every entry gets a decision and no entry is left for a human to judge.

Steps:
1. Go through the entries one by one. Site menu items, news and other things that are plainly not documents need no opening.
   Everything else whose name does not say what it regulates ("Методический документ от ...", "Руководящий документ ...",
   "Методические рекомендации", "Информационное сообщение ...", a bare order number): `fetch_url` it and read it.
2. An entry that belongs and is not in force here: propose `add`. A page with only a heading and a link to the file: `fetch_url`
   the file (PDF if offered) and propose from it.
3. An entry that amends a document in force: `fetch_url` it and call `request_document_review` for that document with its
   fetch_id. An entry that cancels or replaces one: propose `retire` or `replace` with the quote.
4. Call `judge_catalogue_entries` as you go, for every entry above, with the reason in a few words. The app keeps entries
   without a decision open and comes back to them.
5. Reply with a short summary.

`propose_document_change` kinds used here:
- `add`: `title`, `source_fetch_ids`, `reason`, `quote` (from the entry's page).
- `replace`: `document_id`, `title`, `source_fetch_ids` of the new document, a `quote` stating it.
- `retire`: `document_id` and a `quote` stating the cancellation.
- `incomplete: true` with `add` or `replace`: you could not get the whole document. Nothing is stored, the human gets the notice.

For an HTML page pass `start_phrase` and `end_phrase`: the first and last words of the document on the page, copied from its
`text_file`, the end phrase from the end of the document and not its heading. The app refuses a cut that drops most of the page.

`quote` is copied word for word from the text of a page you fetched in this run; `quote_fetch_id` names that page.
The app refuses a proposal it cannot verify; read the error and fix the proposal.
