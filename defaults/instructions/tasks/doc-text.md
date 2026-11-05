Read the document "{{document_title}}" of project "{{project}}" into text. The file is `{{file}}` in the current directory.

1. `Read` the whole file at once, without the `pages` parameter.
2. Save it with `append_document_text`, from the first page to the last: part 1, part 2 and so on, about 15000 characters
   per part, with `last: true` on the final part. Do not stop before the last page.
3. Reply with the number of pages, the parts saved and every place you marked `[unreadable]`.
