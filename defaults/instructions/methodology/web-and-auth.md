## HTTP and identity checks

Use when the module serves HTTP or implements sessions, tokens, OAuth/OIDC, SAML, MFA, password recovery, API keys
or mTLS. Access control asks whether a principal may perform an operation; this section asks whether the HTTP or
identity layer can confuse which principal, request, assurance level or token the operation belongs to.

Discipline:
- For every credential, find the signature or secret verification and every binding its role needs: issuer,
  audience, origin, client, session, principal, resource, assurance, expiry, one-time use.
- `Host`, `Forwarded`, `X-Forwarded-*`, `Origin`, `Referer`, redirect targets, callback state and request-derived URLs
  are trust decisions: trace each to the identity or response it affects.
- A missing header, cookie attribute, MFA prompt or rate limit alone is not a finding. Require an accepted invalid
  request, cross-principal impact, assurance downgrade or credential disclosure.
- Walk issue → store → transmit → consume → refresh → revoke for every credential. Compare normal, error, retry,
  legacy, migration and account-switch paths; the effective policy is the weakest parallel path.

What to check:
- **Host and forwarded headers** decide absolute URLs, tenant routing, callbacks, reset links or the client address
  used for authorization; who can set them and whether trusted ingress strips client copies.
- **Response-header injection**: untrusted data in `Location`, `Set-Cookie` or CSP with control characters.
- **CSRF**: cookie-authenticated state-changing routes (including JSON, multipart, method override, legacy routes)
  accepted cross-site without an anti-CSRF token, effective SameSite or strict Origin check. Read-only routes and routes
  that need a non-ambient bearer token do not qualify.
- **Sessions**: identifier not rotated on login, MFA completion, impersonation or privilege change; still valid after
  logout, password change, revocation or account disable (server sessions, refresh tokens, signed cookies, websockets).
- **Cookie scope**: over-broad `Domain`/`Path`, insecure transport, sibling cookies chosen differently by components.
- **JWT**: signature verified with a server-pinned algorithm and key; `exp`, `nbf`, `aud`, `iss` checked; `kid`, `jku`,
  `x5u` treated as untrusted; no decode-without-verify path. A valid token for another service is invalid here.
- **OAuth/OIDC**: first establish the role (authorization server vs relying party). Exact `redirect_uri` ownership on the
  authorization server; session-bound `state`; PKCE and code binding; ID token issuer, audience, signature and nonce;
  provider binding in multi-provider flows; the same checks on retry, mobile/deep-link and account-link callbacks.
- **SAML**: the signed element is the element used as identity; safe XML parser; validity window, audience/recipient,
  request correlation, replay.
- **MFA and step-up**: enrollment, replacement, disablement and recovery codes require fresh prior assurance; a
  challenge upgrades exactly the intended session, account, action and resource; alternate routes do not skip it.
- **Account linking and recovery**: linking a new identity requires a current session, proven ownership and callback
  state bound to the initiating account; reset tokens are random, bound to user and action, expiring, one-time, and
  invalidate earlier tokens and sessions; reset links are not built from request headers.
- **API keys**: a key cannot reach broader tenants, resources, actions or environments than its server-side record;
  request parameters cannot override those bindings; revocation is not defeated by caches; keys do not leak into
  URLs, logs, errors or client bundles.
- **mTLS**: identity headers are trusted only from the terminating proxy, which strips incoming copies; certificate
  subject is mapped to an account strictly; expired or missing certificates do not fall back to anonymous access.

Proxy chains, cache keys, IdP policy, certificate trust, browser behavior and deployed auth modes may be outside the
repository: if the decision depends on them, the verdict is `needs_human` with the exact missing fact. Verify
framework and library defaults for the version in use before relying on them.
