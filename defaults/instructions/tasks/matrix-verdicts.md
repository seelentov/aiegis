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
3. Read the code each requirement depends on until you can point to the lines that meet or violate it. A control you did
   not find is a violation or `needs_human`, not `pass`.
4. Before any `pass`: a module often does the same job in several places (plugins, providers, handlers, protocol variants).
   Use Grep to list every place in the module that does what the requirement is about, and read each one. One safe
   implementation proves nothing about its neighbours. The `reason` of a `pass` names the places you checked and the
   evidence cites each of them. If you did not check all of them, the verdict is `needs_human`, saying which are left.
5. For violations: `find_similar`, then `link_finding` or `create_finding`.
6. Call `set_verdict` with module_id `{{module_id}}` for every requirement above.
7. Reply with a one-line summary per requirement.
