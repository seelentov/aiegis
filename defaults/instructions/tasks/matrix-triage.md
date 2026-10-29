Triage the applicability of matrix "{{matrix}}" requirements to module "{{module_name}}" (module_id `{{module_id}}`)
in project "{{project}}".

Module description: {{module_description}}

Module files are the tracked files matching these globs (relative to the repository root):
{{module_globs}}

Requirements (decide each one):
{{requirements}}

Steps:
1. Look at the module's build files, layout and entry point map (`get_entry_points` with module_id `{{module_id}}`).
2. Call `triage_cell` with module_id `{{module_id}}` for every requirement above.
3. Reply with the counts of applicable and n/a requirements.
