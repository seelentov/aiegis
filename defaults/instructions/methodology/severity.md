## Choosing severity

Severity is the consequence for this application, not the vulnerability class and not how sure you are. Two flaws of
the same class can be three levels apart. Answer four questions from the code you read, in the description:

1. **What does the attacker gain?** Separately: what they can read, change or destroy, and what they can deny to
   others that they could not before. Name the data or action itself, not the worst thing the class could mean
   elsewhere.
2. **What does it take?** Every precondition lowers severity: the privilege needed (none, an ordinary account, an
   administrator), a victim's action, timing, a non-default configuration, anything you assume but did not see in the
   code.
3. **How far does it reach?** Only the attacker's own data or session, one other user, all users or tenants, other
   systems. Count only spread the code shows; "together with another flaw" belongs to a chain you traced, not to this
   finding.
4. **What is it worth here?** Judge against what this application protects (module description, requirement, data it
   handles): the same leaked identifier is trivial in one system and serious in another.

Caps by what the attacker already has:
- the effect stays on the attacker's own data or session — not a finding; if it still breaks the requirement, `low`;
- an administrator or an equally trusted party is required — at most `medium`, unless it crosses a tenant or escapes
  to the host;
- an ordinary account is required — at most `high`, unless other users or tenants are affected at scale or a core
  control (authentication, authorization, signature check) is bypassed;
- missing hardening, defense in depth or hygiene with no concrete effect — `low` or `info`.

Levels:
- `critical` — little or no privilege, takeover of the application or the data it exists to protect, at scale;
- `high` — serious harm to other users or their data, with preconditions an attacker can realistically meet;
- `medium` — real harm, but narrow, or behind a privilege or condition that is not trivial to get;
- `low` — a real defect with small consequence here, or one too costly to exploit to be worth it;
- `info` — no security consequence on its own; record only when a requirement asks for it.

Each step up needs a fact from the code you can point to. If you cannot name it, or two levels both look right, take
the lower one. If your own reasoning says why the attack does not matter (only the victim sees it, the attacker
already has this access), it is not a finding.
