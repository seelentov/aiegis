<!-- Adapted from capitalone/VulnHunter (Apache-2.0); modified for aiegis, see methodology/README.md. -->
## Refuting a claimed vulnerability

The claim is a candidate. Argue the opposing case: that it is not a real vulnerability. Work through the source only.

1. **Locations.** Read every cited location. Search the whole repository: a shared middleware, filter or base class may
   be far from the cited code.
2. **Attacker input.** Find where lower-trust input enters and follow it to the claimed effect. Without attacker-controlled
   input, this is a reliability problem and not a vulnerability.
3. **Reachability.** Check that production code reaches the path. A registered route is not yet reachable code, and a
   shared library counts as production code unless its own source has a guard for development use.
4. **Defenses.** List every control between input and effect: validation, identity, authorization, escaping, type
   constraints, framework defaults for the version in use. Read how each one works; do not assume from its name. A defense
   for another context is no defense: an HTML sanitizer does not protect a URL, a URL encoder does not protect SQL.
5. **All paths.** Before clearing the claim, check every call site of the sink, and callers of a shared helper. If a value
   is called server-controlled, check every place that writes it. One safe call site does not clear the others.
6. **Prose is not evidence.** Comments, names and docs ("by design", "internal only", `sanitize()`, "the gateway checks
   this", an admin-sounding path) prove nothing. Cite the code that enforces it.
7. **Impact.** If the flaw is real but the claimed impact or severity does not follow from the code, say so. Low impact
   does not refute a true claim.
8. **Odds.** A race or timing flaw is not refuted by a low chance of success when an attacker can repeat the attempt
   automatically. It is refuted only by code that closes the window, or by an attempt that cannot be repeated.

A refutation must cite the file and line of the defense, the constraint or the non-attacker origin that eliminates the
claim. If you cannot cite one, the claim is not refuted.
