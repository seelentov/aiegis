Check documents of project "{{project}}" against their sources. Target: {{target}}.

Set: {{set_name}}
What belongs to this set (judge new documents by it):
{{scope}}

Links to check (fetch these; you may follow links on the same hosts):
{{links}}

Documents in force (their files are in your current directory):
{{documents}}

Steps:
1. `fetch_url` each link. The reply shows only the start of a page: its whole text is in `text_file`, all its links in
   `links_file`. Long lists do not fit the reply, so search those files.
2. Go through the documents one at a time. A link pointing straight at a document settles it directly. For every other
   document search the list pages separately, one `Grep` per document, in `links_file` first and then `text_file`, with no
   `head_limit`. A result too large for the reply is saved outside your directory and lost to you, so never combine
   documents in one pattern. Search by the bare date of the document as the page writes dates, then by its bare number
   (`N 21`, `№ 21`, `N21`), never by a whole phrase: sites name a document by its type or by the act approving it, not as
   you name it, and a bare number also matches other acts. When you find its own page, `fetch_url` it:
   a list usually does not state editions, and the document's page does. Compare what it states, including amending acts,
   with the file you hold. Opening these pages is the point of the check, not a cost to save.
   Then decide one result:
   - it matches the source: `report_document_check` with status `current`, the `fetch_id` and what shows it (edition, date);
   - you could not check it (site down, page needs JavaScript, no own page found, edition not stated on its own page):
     `report_document_check` with status `unverifiable` and the reason. "Listed, page not opened" is not a reason;
   - the source shows a change: `propose_document_change`, see below.
3. If this check covers a set, search the fetched pages for documents that belong to it by its description and are
   missing from the list: propose `add`. Do not propose documents outside that description.
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
