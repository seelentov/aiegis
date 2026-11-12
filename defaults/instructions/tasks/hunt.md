Hunt for vulnerabilities in module "{{module_name}}" (id {{module_id}}) of project "{{project}}".

Module description: {{module_description}}

Module globs (relative to the repository root):
{{module_globs}}

Your batch ({{file_count}} files):
{{files}}

Steps:
1. Call `whoami`. Call `get_entry_points` for the module: it shows where untrusted input enters and the call chains.
   Call `get_signals` for the module: scanner results are hints, not proof, and their absence proves nothing.
2. For each file of the batch, find what it does with input that a lower-trust party controls (request fields, headers,
   files, messages, data written by other tenants) and with identity and permissions: injection into queries,
   commands, templates, paths or URLs; missing or bypassable authentication and authorization, object access without
   an owner or tenant check; unsafe deserialization; weak or misused cryptography; leaks of secrets or personal data;
   flaws in business logic. Follow a flow into other files when it leaves the batch.
3. For each flaw that survives your own refutation: `find_similar`, then `create_hunt_finding` unless the same flaw
   is already recorded.
4. Call `mark_files_reviewed` for the files you finished as you go; every file of the batch must be marked at the end.
