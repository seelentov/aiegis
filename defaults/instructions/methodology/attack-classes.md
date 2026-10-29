## Attack classes to consider

Use only the classes relevant to the requirements you check and to this module. A flag is not a finding: trace the
impact through the full code path before reporting.

**Injection.** Trace untrusted input from the entry point to dangerous sinks: SQL/NoSQL queries, HTML output, shell
commands, template engines, file paths, redirects, deserialization, LDAP/XPath, log lines. Look beyond direct paths:
data stored safely and later used in a dangerous context by other code; injection through field names, keys, headers
and metadata, not just values; injection into secondary systems (logs, caches, search indexes).

**Access control.** Verify the *right* permission for the *right* resource via the *right* mechanism:
- another path to the same state change that checks a weaker permission;
- a request body field that overrides what the permission system restricts;
- endpoints that check authentication but not authorization;
- the same resource reachable through several paths with inconsistent checks;
- bulk/batch/export/import operations that skip per-item checks.

**Resource and file handling.** Path traversal (symlinks, encoded sequences), SSRF (redirects, URL parser
differentials), unsafe deserialization, archive extraction (zip slip), temp files, TOCTOU between check and use.

**Cryptography and secrets.** Weak randomness for tokens, keys and nonces; secrets in logs, errors, URLs or responses;
missing HMAC/signature verification; non-constant-time secret comparison; misused primitives (ECB, static IV,
unauthenticated encryption); error paths that fall back to no crypto.

**Business logic.** For each major workflow: skipped, reversed or replayed steps; partial failure without rollback;
non-atomic check-then-act races (double spend, lost updates); negative, zero, overflowing or coerced quantities;
expiry and time-window boundaries; insecure behavior when config is missing, a feature flag is off or a dependency is
unavailable; data trusted because "it was validated on the way in" although another path could write it.

**Feature abuse and data leakage.** Export/backup that includes data above the caller's access; import/restore that
bypasses validation or permissions; search, filter or sort as an oracle for hidden data; enumeration through
different errors, status codes, sizes or timings; preview/draft tokens with broader scope than one item;
user-controlled webhook/callback URLs fetched by the server.

**Chained trust boundaries.** Compare the exact guarantee component A produces with what component B assumes
(truncation, type coercion, normalization, tenant scope). Second-order use: a stored value later used as a path, URL,
template, regex or query. Token, API key or plugin capabilities that grow after delegation, refresh, caching or role
change. Stale state after revoke, soft delete, migration or cache expiry. Restore/rollback that skips current
ownership and authorization checks.

**Overlooked basics.** Debug/dev modes switchable in production by env, query parameter or header; test or seed
credentials; unprotected `/debug`, `/admin`, `/actuator`, `/metrics`, `/env`, `/config` endpoints; `eval`/`exec`/
dynamic class loading with external input; permissive CORS (wildcard with credentials); open redirects (`redirect`,
`return`, `next`, `url` parameters); stack traces or SQL errors in responses; security-related TODO/FIXME/HACK comments.

Read code that looks boring, legacy, experimental or half-finished, and API calls the UI never makes. If a comment
explains why something is safe, verify the explanation.
