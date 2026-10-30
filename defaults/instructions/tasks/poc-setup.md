Set up the PoC test environment of project "{{project}}": make the application from this commit start as a test
instance, describe it with `set_poc_environment` and check it with `check_poc_environment` until it is `ready`.

The user's checkout (readable; local docs, skills and configs that are not committed): `{{project_root}}`

Current environment (project config `poc`):
{{environment}}

Test accounts (configured by a human; secrets are env variables of the instance commands):
{{accounts}}

Scripts directory (`$AIEGIS_POC_SCRIPTS`): `{{scripts_dir}}`
Variables of the app's environment the commands see: {{env_passthrough}}

Output of the last test instance that did not start:
```
{{last_failure}}
```

Call `whoami`, then follow the loop of your role instructions. If the current environment is described, do not save
it again unchanged: start it with `check_poc_environment` first, or find why it failed.
