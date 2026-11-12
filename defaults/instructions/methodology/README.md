Methodology fragments appended to role instructions (see `roles.matrix.instructions` in `config.yaml`;
`web-and-auth.md` is off by default, add it per project or module).

`attack-classes.md`, `web-and-auth.md` and `verdict-discipline.md` are adapted from
https://github.com/cloudflare/security-audit-skill (commit c1c8a8c1471069fb0e188eeaff69b8e8db6564a8,
files `ATTACK-CLASSES.md`, `WEB-PROTOCOL-AND-AUTH.md`, `VALIDATION-AND-REPORTING.md`), Copyright (c) 2025-2026
Cloudflare, Inc., MIT License — see `LICENSE-security-audit-skill`. Changes: the skill's phases, sub-agents and
report files are removed; verdicts are mapped to aiegis verdicts.

`refutation.md` is adapted from https://github.com/capitalone/VulnHunter (commit
6d25b5c58b7820809b391ecda6a102537effe3ba, file `vulnhunt/phases/phase2b_verify.md`), Apache License 2.0 — see
`LICENSE-VulnHunter`. Changes: rewritten and shortened to a refutation method for one claim; the manifest, gates, verdict
table, severity ladders and rules for the original company's gateways are removed; outcomes are mapped to aiegis
outcomes. It is part of role `finding-verify`.

`severity.md` is written for aiegis. It is part of roles `matrix`, `matrix-economy`, `diff-check`, `sca` and
`finding-verify`.

This file is not loaded into prompts.
