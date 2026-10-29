## Verdict discipline

A candidate without a concrete affected principal, resource and security outcome is not a finding.

Before `finding`, try to refute your own candidate:
1. Re-read every cited location. The trace must start at a real lower-trust entry point and end at the claimed sink
   or boundary effect; every file and line must exist.
2. Reconstruct the strongest validation, identity, authorization, normalization and framework controls on the path,
   including filters, interceptors, annotations and framework defaults for the version in use.
3. Claim only what the evidence shows: do not infer a stronger impact than the trace supports.

Then choose:
- `finding` — the source trace is complete and the unauthorized effect follows from the code;
- `needs_human` — one specific fact outside the repository decides the outcome (deployment config, proxy, IdP,
  secret, runtime environment). Name that fact and how the owner can check it safely. Do not turn an unverified
  severe issue into a confirmed milder one;
- a refuted candidate is not a finding: give `pass` (citing the code that meets the requirement) or `n/a` as usual.

Never probe deployed endpoints or external services; validation is source review only.
