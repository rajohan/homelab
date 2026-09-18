# Identity security model

## Trust boundaries

Auth is a small privileged identity service, not a homelab administrator. It receives only its
database credential, data-encryption key, OIDC signing/cookie keys, configured client secrets,
proxy credential and Resend sender access. Dashboard receives only its own OIDC credential
and session encryption key. Neither receives GitHub, Docker, SSH or other application secrets.

Account creation is operator-only. There is no public signup or unauthenticated bootstrap.
Accounts have stable UUID subjects, lowercase usernames and explicit groups. Existing UUIDs
may be supplied only for a reviewed account-linking migration, never inferred from an email
address. No production users, password hashes, factors or approvals are imported by this PR.

## Account UI availability

Self-service account management intentionally lives only in dashboard Settings. Auth
`/account` redirects there; there is no second account page to maintain on the auth origin.
The auth service owns authentication, OIDC, ForwardAuth and account-security APIs, which
remain operational without dashboard. During a dashboard outage, existing users can still
sign in to other services, but browser enrollment and account changes are unavailable until
dashboard returns. In particular, a new account cannot enroll its first factor during that
outage. Operator recovery remains available through the auth CLI; this does not bypass a
client's MFA requirement or automatically enroll a factor.

## Passwords and sessions

Passwords are Argon2id hashes (64 MiB, time cost 3). Hash/verification concurrency is bounded
globally and login/proof/recovery requests are rate limited in PostgreSQL. Unknown-user login
still performs password verification. Password hashes are rechecked under the user lock before
committing a login or password change, including concurrent recovery races.

Central sessions have random 256-bit opaque cookies; only SHA-256 token digests are stored.
Production cookies are Secure, HttpOnly, SameSite=Lax and host-only with the `__Host-` prefix.
By default, absolute lifetime is 12 hours and idle lifetime one hour. An explicit, unchecked-by-default
**Remember me** choice uses 30 days absolute and seven days idle. All five durations, including
step-up, are bounded deployment settings; see the operations guide. Remembered sessions still
require enrolled MFA at login and recent proof for sensitive changes. Absolute expiry never slides.
The same central policy gates cookies, account APIs, protocol tokens and expiry cleanup. Successful password proof and protected
account mutations renew idle activity transactionally; failed actions and passive reads do not.
Sensitive changes require proof within
five minutes. At most 16 password-only sessions and 16 MFA-completed sessions are retained
per account. Password-only logins cannot evict MFA-completed sessions or their OIDC grants;
the completed-session cap is enforced only after a successful second factor. MFA-enrolled accounts cannot access settings or clients with password alone.

The dashboard's HttpOnly JWE cookie carries its opaque account-scope token to its BFF, not to
browser JavaScript. Every BFF request still checks central state. Removing a session deletes its
grant-bound protocol records immediately; keeping a stale cookie does not preserve access.
Signed ID tokens already issued to third-party apps cannot be recalled cryptographically:
those apps must enforce their own session lifetimes, logout and/or introspection policy.

Password reset revokes every session but **does not remove MFA**. Ordinary password changes
revoke other sessions and pending challenges. Operator recovery is an explicit CLI action;
resetting MFA requires the additional `--reset-mfa` option.

## MFA and WebAuthn

TOTP is six digits/30 seconds with a one-step clock window. Accepted counters cannot be reused,
including concurrent requests. Ten recovery codes are generated, shown once, stored as hashes
and consumed transactionally. First-factor enrollment revokes other sessions. Removing the
last factor clears recovery codes and requires recent proof first.

SimpleWebAuthn verifies registration/assertion signatures, exact approved origins, RP ID,
challenge, user/session binding, credential ownership, user presence and required user
verification. Counters are stored as bigint-compatible numbers. Credentials retain advertised
USB/NFC/hybrid transports; there is no desktop-only attachment requirement.

Choose an RP ID covering **only domains you control**, before enrollment. With separate auth
and dashboard origins, a common parent RP ID permits modal ceremonies from both. The backend
accepts only those two configured origins. Moving to another RP ID requires re-enrollment;
a different port/origin is not an interchangeable callback alias.

Physical YubiKey USB, YubiKey NFC on iPhone, cancellation/PIN retries and native Nextcloud
authorization are mandatory manual gates. Software-signed test authenticators prove backend
verification logic, not hardware/browser UX.

## OIDC

The maintained oidc-provider engine owns authorization code, S256 PKCE, claims, discovery,
JWKS, userinfo, refresh rotation, token introspection/revocation and confirmed RP logout.
Confidential clients and exact redirect/logout URIs are statically configured; no dynamic
registration, implicit flow, wildcard callback or arbitrary OAuth origin is accepted.
Client-secret-basic and client-secret-post are supported. Browser CORS to token endpoints is
disabled; use a confidential server-side client.

Only dashboard can request `account` scope. Other clients require MFA. A newly created account
without a factor may enter dashboard Settings to enroll; it cannot enter a protected resource
or another OIDC client before MFA. Every client, including dashboard, requires explicit
**Approve** or **Deny** when the provider requests consent. Registration never grants automatic
approval. The shared-design auth page shows the server-validated app name, callback origin and
requested scopes; the browser cannot choose additional scopes or a different client. Denial returns
`access_denied` without signing out the central account. Dashboard presents a deliberate retry page,
not JSON or an automatic sign-in loop. A decision is bound to the displayed interaction and account;
a conflicting replay is rejected rather than silently continuing the opposite decision. A transaction-scoped
PostgreSQL advisory lock serializes decisions for the same interaction across processes. One dedicated
connection orders local handoffs without occupying the seven-connection provider/account pool; the
service retains its total budget of eight. Lock contention is retryable and records no decision.

User-owned approval receipts persist across central-session logout and expiry. They contain the
approved scopes and a fingerprint of recipient metadata, never tokens. Additional permissions,
changed recipient names/destinations, explicit `prompt=consent`, or revocation require approval again.
Settings lists approved apps with a step-up-protected revocation action that removes the receipt,
revokes its session-bound grants and queues supported back-channel logout. Other accounts' receipts
are unaffected. Protocol grants and tokens remain bound to an actual live central session: remembering
consent is not remembering authentication, and never bypasses group or MFA checks. Existing pre-consent
grants without a client binding are rejected and require a fresh app sign-in. No dynamic client
registration is enabled.

Leaving a sign-in page open does not extend its OIDC interaction lifetime. After
successful authentication, an expired interaction can restart once automatically
at the registered client's single-origin entry point. This creates fresh protocol
state rather than replaying an expired code, nonce or consent decision. Unknown,
removed, disallowed or multi-origin clients fall back to account settings. The
expired request's deep link is not recovered. The same-origin, cookie-authenticated
restart endpoint accepts only a public client identifier, never a return URL;
normal client, group, MFA and consent checks still apply to the new request.
A per-tab retry guard prevents redirect loops, and explicit consent failures
require an explicit restart instead of silently replaying Approve or Deny.

RP logout always uses the library's CSRF-validated POST before ending the central session.
A validated ID-token hint matching both the current central account and the current
client's protocol SID automatically submits that form, avoiding a second confirmation
after an app's Log out action. Unsigned, different-account and stale-session requests
still require explicit confirmation. Session-bound back-channel logout uses the provider's
native signed tokens, with an encrypted transactional retry queue for Settings revocation,
recovery, expiry and RP logout. Each new grant receives a fresh SID; delayed delivery cannot
target a subsequent login. Receivers must support the protocol and duplicate delivery.
Client failure does not undo central revocation. See the operations guide for retry bounds
and per-client qualification; no unsupported consumer is assumed to have logged out.

## ForwardAuth and public endpoints

Requests are accepted only from a proxy presenting the dedicated constant-time-checked
credential. Forwarded host/protocol/path are validated against explicit route policies.
Authentication failure, database failure, unknown hosts and missing configuration fail closed.

Resource sessions use per-host encrypted cookies, not a parent-domain cookie shared by every
application. Resource activity renews idle time only with consistent same-origin Origin or
Sec-Fetch-Site evidence forwarded by the trusted proxy; sibling or headerless requests can
remain authorized but do not extend idle lifetime. A short-lived handoff ticket binds the central session, destination, browser nonce
and one-time redemption. Spoofed identity headers, unrelated hosts and replayed tickets fail.

Public exceptions are exact paths, segment prefixes, or ordered anchored RE2 resource rules.
Unknown origins are denied; registered origins default to MFA with allowed groups.
Ambiguous encoded separators, malformed encoding and control characters are denied. Inventory media manifests, catalog/meta/stream/subtitle APIs, MediaFlow,
CometNet, Hydra, authenticated NZB endpoints, short links and Nextcloud WebDAV/mobile
**before cutover**. Do not blanket-protect endpoints whose non-browser clients cannot log in.

## Email and sensitive state

Resend receives email only through its fixed HTTPS API with a timeout and idempotency key.
A transactional outbox encrypts messages at rest, bounds retries and expires undelivered
proofs. Public reset admission is limited atomically to four jobs per minute across all
requesters, alongside per-IP/per-name limits, without checking whether an account exists.
All three limits and enqueueing commit in one admission transaction, so a rejected local
attempt cannot consume global capacity. This
keeps anonymous reset work below the maintenance worker's capacity and reserves throughput
for authenticated verification mail. Over-capacity requests receive the same rate-limit
response for known and unknown accounts. Verification/reset tokens expire after 30 minutes and are consumed once. Link tokens
are in URL fragments and immediately removed from browser history; they are not query strings
in proxy logs. Changing email requires proof and verification of the new address before the
current address changes; a previous verified address receives a notification.

TOTP secrets, WebAuthn stored payloads, protocol records and outbox messages use AES-256-GCM
with purpose-bound authenticated data. Metadata needed for indexing remains plaintext.
Never replace the encryption key casually: existing encrypted records would become unreadable.
The offline `rotate-data-key` command verifies and re-encrypts all persistent encrypted columns
atomically. Stop every auth process, follow the documented check/apply/secret-update sequence
and retain backup-era keys. Cookie keys and OIDC signing keys have distinct lifecycles.

Logs contain bounded event names, not credentials, raw requests, tokens or email bodies.
Security activity retains 90 days of sanitized events. Dev-only delivery prints synthetic mail
to the local terminal; never enter production identities into the disposable preview.

## Browser and proxy hardening

Built HTML/assets include CSP (self-hosted scripts, no frames/objects/base injection), nosniff
and no-referrer headers. JSON APIs use no-store. Production must be behind verified HTTPS,
with rate limits/body bounds and no direct app exposure. Proxy logs must omit cookies,
Authorization, proxy credentials and sensitive callback query strings. TLS inside the trusted
deployment network and firewall boundaries must be reviewed separately.

Maintained libraries reduce protocol/crypto risk, but this custom integration is not an
independently audited or OpenID-certified product. Bun compatibility is tested locally;
oidc-provider still officially targets Node LTS. Do not hide that distinction.
