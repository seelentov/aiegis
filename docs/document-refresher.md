# Document refresher

Standards change. The refresher compares your documents with their sources and creates proposals. A person applies them, through the normal extraction and review.

![A proposed new edition of a document](screenshots/document-proposal.png)

## Sets

A set has a name, a description of what belongs to it, and links. A document belongs to at most one set.

- You decide the membership. The agent only proposes new documents for the set being checked, judging them by the set's description.
- **New set** creates one on the **Documents** tab, where documents are grouped by set.
- Removing a set leaves its documents, outside any set.
- The plan of [AI-written documents](documents.md#security-documents-written-by-ai) creates a set of its own. It has no links, and those documents are updated with **Rewrite**.

## Running a check

| Check | Needs | Looks at |
|---|---|---|
| A whole set | A link on the set | The set's links only. Documents out of force are skipped, and the links of individual documents are not opened |
| One document | A link on the document (it may be outside any set) | That document only |

Start a check with the button on a set or document, with `aiegis doc check`, or with a [schedule](schedules.md). The estimate shows the documents, links and tokens, with the figure taken from run history or configuration. Starting a check that is already active returns the active job.

**Compare the sources first.** The app downloads the sources from the last successful check again before any agent starts:

- everything matches, and the membership and links are the same: no AI runs, and the document stays `current`;
- a site does not respond: the status is `unverifiable` with no AI;
- **Run with AI anyway** (`--force`) always starts the agent.

Hashes of HTML pages are taken from the text without menus, scripts and headers. Lines matching `doc_refresh.volatile_lines`, such as view counters, are left out too. A source whose content shifts in other ways, such as a rotating block of links, keeps waking the agent, so prefer an official source for it.

## How a set is checked

A set check has up to three parts:

1. **Overview** (`doc_refresh`): the agent downloads the set's links, finds each document's page, and hands over pages and catalogues using `request_document_review` and `request_catalogue_review`.
2. **Document comparison** (`doc_review`): reads both texts and decides. It has its own baseline and runs only if that document's page changed. If a comparison fails, the set's baseline is dropped so that the next check returns to it.
3. **Catalogue pass** (`doc_catalogue`): the app takes every link from a listing page on the same host, drops the ones already decided, and splits the rest into batches of `doc_refresh.catalogue_batch`. Each entry gets a stored decision, because an agent asked to walk a long catalogue by itself tends to stop early. An entry with no decision makes the run unsuccessful and comes back in the next check. New entries are read only once.

**Catalogue entries checked** shows the decisions on the **Documents** tab, and `aiegis doc catalogue <set>` prints them.

## Network limits

The agent has no `WebFetch`, `WebSearch`, shell or write access, and reads only its own directory. Pages are downloaded by the app, through the MCP tool `fetch_url`:

- **Protocols:** `http` and `https` only.
- **Allowed hosts:** in a set check, the hosts of the set's links. For a document outside any set, the host of its link. For a document in a set, its link and the links of the set (to look for a replacement). The whole host is allowed, not just the path.
- **Private addresses:** blocked by checking at DNS resolution. `doc_refresh.allow_private_addresses` allows them, for an internal wiki.
- **Limits:** `max_bytes`, `timeout_sec`, `max_redirects`. All requests go to the log.
- **Redirects:** intermediate hosts may be any public host, such as a sign-on service, and the agent does not see their content. The final host must be allowed. Cookies live in memory for one request.
- **Certificates:** you can set `insecure` on a link for a site whose certificate cannot be verified. It applies to that host in the run, except for other hosts in a redirect chain. A document inherits the flag from a set link to the same host.

Anything received over plain HTTP or without a certificate check is marked as an **unverified channel**, because anyone on the path could have changed it. Compare it with the source before applying it.

## Pages and text

The app converts HTML to text without AI. The agent names the first and last phrase of the document and the order of its pages. The version is then imported as MD with the pages stored next to it. As a fallback, the agent may submit its own text, labeled as restored by AI, if at least `doc_refresh.restored_min_coverage` of its paragraphs are on the page. The review warns you about this. The `fetch_url` reply shows only the start of a page and the first `max_links` links; the full text and links are in files the agent reads.

You cannot upload `.html` by hand.

## Results and proposals

The agent's `current` and `unverifiable` results are stored directly. A site that refuses, or a document that cannot be found, is `unverifiable`, and the date of the last check is not moved. Changes become proposals:

| Kind | Meaning | When applied |
|---|---|---|
| `update` | A new edition of a document | A new version goes to extraction and review |
| `add` | A new document in the set | A new document in the set, added to the matrices you choose; by default those with documents of the set. Cells appear after approval |
| `replace` | A new document replaces this one | A new document in the same matrices. The old one goes out of force when the new one is first approved, and stays if the new one is discarded |
| `retire` | The document is no longer in force | The document goes out of force |
| `link` | A link was found for a document | The link is saved |

An `incomplete` result is only a notice: the source shows only part of the document, so no file is stored. Upload the file yourself; applying only marks it as handled.

A proposal is `pending`, `applied`, `rejected` or `outdated`:

- A repeat check finds a pending proposal again as a duplicate, and the document stays `changed`.
- A rejected proposal does not come back while the source stays the same.
- Something newer at the source moves the older proposal to `outdated`.
- Files of rejected and outdated proposals are removed.

In the details, **Apply** and **Reject** decide a proposal. Applying all additions at once is available only for the first filling of an empty set.

## Protection against false changes

A proposal is refused when:

- its quote is not in the text downloaded in this run (for an update by PDF or DOCX file, the evidence is a different hash and edition instead);
- an update adds no paragraph and removes at most `same_text_max_removed_lines` lines;
- an update has no edition;
- an update is shorter than `update_min_length_ratio` of the current text, which suggests only part of the document;
- a cut by start and end phrases keeps less than `crop_min_ratio` of the page, which suggests a wrong end phrase;
- a `retire` or `replace` has no quote.

A file that matches a document outside any set moves that document into the set; a match with a document in another set is an error.

## Settings

See [`doc_refresh`](configuration.md#doc_refresh) for all limits, and `limits.max_tokens_per_document_run` for the token limit of document runs.

## Command line

```bash
aiegis doc-set save 'Internal standards' --scope 'Security standards of the company' --link https://wiki.example/standards/
aiegis doc-set list
aiegis doc-set assign <document> --set <set>
aiegis doc-set remove <set>
aiegis doc source <document> https://example.com/standard.pdf
aiegis doc check-estimate --set <set>
aiegis doc check --set <set>            # or --document <id>; --force always runs the agent
aiegis doc catalogue <set>
aiegis doc-proposal list
aiegis doc-proposal accept <proposal> [--matrix <id>]
aiegis doc-proposal reject <proposal> 'Not relevant to us'
aiegis doc-proposal accept-additions <set>
```

`--insecure-link` on `doc-set save` and `--insecure` on `doc source` and `doc import` skip the certificate check for that host.
