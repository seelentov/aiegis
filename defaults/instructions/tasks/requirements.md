Extract the requirements of document "{{document_title}}" (version {{version_n}}, document_version id `{{version_id}}`)
for project "{{project}}".

The document is the file `{{file}}` in the current directory (format: {{format}}).

Requirements of the previous approved version (reuse their `key` for the same requirement, even if reworded; if its
wording in the document did not change, also reuse its text and split exactly as before; may be empty):
{{previous}}

Steps:
1. Read `{{file}}` completely.
2. Call `add_requirement` with `version_id` `{{version_id}}` for each requirement.
3. Reply with the number of requirements you recorded.
