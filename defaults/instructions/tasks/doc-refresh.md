Check documents of project "{{project}}" against their sources. Target: {{target}}.

Set: {{set_name}}
What belongs to this set (judge new documents by it):
{{scope}}

Links to check (fetch these; you may follow links on the same hosts):
{{links}}

Documents in force (their files are in your current directory):
{{documents}}

Steps:
1. `fetch_url` each link. Read the reply; the whole text of a page is in its `text_file`.
2. For each document decide one result:
   - it matches the source: `report_document_check` with status `current`, the `fetch_id` and what shows it (edition, date);
   - you could not check it (site down, page needs JavaScript, not found, edition not stated):
     `report_document_check` with status `unverifiable` and the reason;
   - the source shows a change: `propose_document_change`, see below.
3. If this check covers a set, look for documents that belong to it by its description and are missing from the list:
   propose `add`. Do not propose documents outside that description.
4. Reply with a short summary of the results.

`propose_document_change` kinds:
- `update`: a new edition of the same document. Fetch the file or the page holding the full new text and pass it in
  `source_fetch_ids` (several pages in reading order if the document is split). State `edition`.
- `add`: a new document for this set. `title`, `source_fetch_ids`, `reason`, `quote`.
- `replace`: another document replaces this one. `title`, `source_fetch_ids` of the new document, and a `quote` stating
  the replacement.
- `retire`: cancelled without replacement. A `quote` stating the cancellation.
- `link`: a document without a link was found on the source: `source_fetch_ids` with its page, `quote` naming it.

For an HTML page pass `start_phrase` and `end_phrase`: the first and last words of the document on the page, copied from
its `text_file`. The app cuts the text itself, so it stays word for word. If the conversion is really broken (text cut or
mixed with the site's menus) you may pass the whole text in `restored_text` instead: it is costly and marked for the human,
and it is refused unless its paragraphs are found on the page.

`quote` is copied word for word from the text of a page you fetched in this run; `quote_fetch_id` names that page.
The app refuses a proposal it cannot verify; read the error and either fix the proposal or report the document instead.
