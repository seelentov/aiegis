Decide whether the vulnerabilities of package {{package}} (package_key `{{package_key}}`) are reachable from module
"{{module_name}}" (module_id `{{module_id}}`) of project "{{project}}".

Module description: {{module_description}}

Module files are the tracked files matching these globs (relative to the repository root):
{{module_globs}}

Package: {{package}}; declared by the module directly: {{direct}}; brought in by: {{manifest}}
How code refers to it (import names): {{import_names}}
Module files that refer to it (found by aiegis without AI):
{{import_hits}}

Vulnerabilities (give a verdict for each one):
{{vulnerabilities}}

Steps:
1. Read how the module uses the package (start from the files above; if there are none, find out how the module reaches
   it through other libraries) and where untrusted input enters (`get_entry_points` with module_id `{{module_id}}`).
2. For each vulnerability decide whether the module uses the vulnerable part of the package.
3. For reachable ones: `find_similar`, then `link_sca_finding` or `create_sca_finding`.
4. Call `set_sca_verdict` with module_id `{{module_id}}` and package_key `{{package_key}}` for every vulnerability above.
5. Reply with a one-line summary per vulnerability.
