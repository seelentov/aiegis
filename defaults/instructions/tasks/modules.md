Mark up the repository of project "{{project}}" into audit modules.

Additional instructions from the user (take precedence over everything else):
{{hint}}

Current modules (may be empty):
{{modules}}

Steps:
1. Look at the build files and top-level layout to find the modules.
2. For each module call `upsert_module` with name, globs and a one-sentence description.
   Keep names of existing modules that are still valid (pass their `module_id` to change their globs or name).
3. Reply with a short list of the modules you wrote.
