Build the entry point map of module "{{module_name}}" (module_id `{{module_id}}`) in project "{{project}}".

Module description: {{module_description}}

Module files are the tracked files matching these globs (relative to the repository root):
{{module_globs}}

Steps:
1. Find every entry point of the module (stay inside the module files; follow calls outside only to reach sinks).
2. Call `upsert_entry_point` with `module_id` `{{module_id}}` for each of them.
3. Reply with the number of entry points you recorded and anything you could not resolve.
