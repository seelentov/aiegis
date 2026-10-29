Reproduce suspected finding {{finding_id}} of project "{{project}}" against the test instance.

Title: {{title}}
Severity: {{severity}}; CWE: {{cwe}}
Module: {{module_name}}; entry point: {{entry_point}}

{{description}}

Code locations:
{{files}}

Recommendation: {{recommendation}}

Test instance (already started from this commit): {{base_url}}
Send requests to this base URL only.

Test accounts:
{{accounts}}

Directory for your scripts: `{{out_dir}}/`.

Steps:
1. Call `whoami`. Read the code locations; use `get_entry_points` for the route, its parameters and authorization.
2. Plan the smallest scenario that shows the flaw (for access control: act as one account, target another account's
   or tenant's data). Check first that the request works for its legitimate owner, so a refusal means a defence and not
   a broken request.
3. Run it with `curl` (one command per call) or a script in your directory.
4. Call `set_poc_result` with `finding_id` = {{finding_id}}, the outcome, a summary and the steps you ran with the
   responses you observed.
