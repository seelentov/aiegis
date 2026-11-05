Check documents of project "{{project}}" against their sources. Target: {{target}}.

Set: {{set_name}}
What belongs to this set (judge new documents by it):
{{scope}}

Links to check (fetch these; you may follow links on the same hosts):
{{links}}

Documents in force (their files are in your current directory):
{{documents}}

Taken out of force by a human, do not propose them again:
{{retired}}

The aim is that this set is complete and current. Missing a document in force is the worst outcome; do not save effort here.

Steps:
1. `fetch_url` each link. The reply shows only the start of a page: its whole text is in `text_file`, all its links in
   `links_file`. Sources are written by people and have no fixed form.
2. Each document in force: find its own page on the sources. Search `links_file`, then `text_file`, one `Grep` per document
   with no `head_limit` (a result too large for the reply is saved outside your directory and lost to you, so never combine
   documents in one pattern). Search by the bare date of the document as the page writes dates, then by its bare number
   (`N 21`, `№ 21`, `N21`), never by a whole phrase: sites name a document by its type or by the act approving it.
   - Found: `fetch_url` its page and call `request_document_review` with its fetch_id. A separate run reads the document and
     that page, and decides. Several sources for one document: pass them all.
   - Not on any source: `report_document_check` with status `unverifiable` and what you searched for.
3. Every fetched page that is a list of documents: call `request_catalogue_review` with its fetch_id. Separate runs then judge
   each of its entries, so do not go through them here. If only a list states that a document in force is cancelled or
   replaced, propose `retire` or `replace` here with that quote.
4. Reply with a short summary: what was handed over, what was proposed and what could not be checked.

`propose_document_change` kinds used here:
- `replace`: another document replaces one in force. `title`, `source_fetch_ids` of the new document, a `quote` stating it.
- `retire`: cancelled without replacement. A `quote` stating the cancellation.
- `incomplete: true` with `replace`: the source shows only part of the document (login, a fragment). Nothing is stored, the
  human gets the notice and uploads the file. Never pass a partial text as the document.

For an HTML page pass `start_phrase` and `end_phrase`: the first and last words of the document on the page, copied from its
`text_file`, the end phrase from the end of the document and not its heading. The app cuts the text itself, so it stays word
for word, and refuses a cut that drops most of the page.

A page with only a heading and a link to the file: `fetch_url` the file (PDF if offered) and propose from it. `incomplete` is
only for a document you could not get whole.

`quote` is copied word for word from the text of a page you fetched in this run; `quote_fetch_id` names that page.
The app refuses a proposal it cannot verify; read the error and either fix the proposal or report the document instead.
