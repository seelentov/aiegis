Extract the requirements of document "{{document_title}}" (version {{version_n}}, document_version id `{{version_id}}`)
for project "{{project}}".

The document is the file `{{file}}` in the current directory (format: {{format}}).

Already recorded: requirements of the previous approved version whose quoted text is unchanged in this document.
aiegis carried them over; do not record them or their sentences again (`add_requirement` rejects that):
{{carried}}

Requirements of the previous approved version whose quoted text changed or is gone (reuse their `key` for the same
requirement, even if reworded; may be empty):
{{previous}}

Steps:
1. Read `{{file}}` completely.
2. Call `set_document_info` with `version_id` `{{version_id}}`.
3. Call `add_requirement` with `version_id` `{{version_id}}` for each requirement not already recorded.
4. Reply with the number of requirements you recorded.
