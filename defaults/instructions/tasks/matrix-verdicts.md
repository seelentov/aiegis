Check module "{{module_name}}" (module_id `{{module_id}}`) of project "{{project}}" against requirements of matrix
"{{matrix}}", group "{{group}}".

Module description: {{module_description}}

Module files are the tracked files matching these globs (relative to the repository root):
{{module_globs}}

Requirements (give a verdict for each one):
{{requirements}}

Steps:
1. Read the entry point map (`get_entry_points` with module_id `{{module_id}}`) and the code relevant to the requirements.
2. For violations: `find_similar`, then `link_finding` or `create_finding`.
3. Call `set_verdict` with module_id `{{module_id}}` for every requirement above.
4. Reply with a one-line summary per requirement.
