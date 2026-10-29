Check module "{{module_name}}" (module_id `{{module_id}}`) of project "{{project}}" against requirements of matrix
"{{matrix}}", group "{{group}}".

Module description: {{module_description}}

Module files are the tracked files matching these globs (relative to the repository root):
{{module_globs}}

Requirements (give a verdict for each one):
{{requirements}}

Signal suppressions made by humans for this module (examples of accepted cases):
{{suppressions}}

Steps:
1. Read the entry point map (`get_entry_points` with module_id `{{module_id}}`) and the code relevant to the requirements.
2. Call `get_signals` with module_id `{{module_id}}` and the requirement_id for each requirement; treat signals as hints
   to verify, not as a complete list.
3. For violations: `find_similar`, then `link_finding` or `create_finding`.
4. Call `set_verdict` with module_id `{{module_id}}` for every requirement above.
5. Reply with a one-line summary per requirement.
