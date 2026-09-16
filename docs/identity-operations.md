# Identity operations and cutover

## Scoped configuration

The nonsecret `.env.example` lists every runtime key. Empty secret placeholders intentionally
prevent production startup. Use Doppler injection or the existing root-protected RAM delivery,
not committed env files, Docker build arguments or machine-specific project helpers.

Use separate least-privilege runtime configs: `apps_homelab_auth` on Edge and
`apps_homelab_dashboard` on Main. A single canonical value may be referenced by consumers;
do not copy the same credential into unrelated configs. Neither scope needs host access.

Resend naming: `RESEND_API_KEY` becomes `HOMELAB_AUTH_RESEND_API_KEY`. Inventory live consumers
before deleting the old name. If an old application remains active, temporarily make its old
name a Doppler reference to the canonical new name; remove that alias only after updating the
consumer. The application intentionally has **no fallback** to the legacy name.
Use the sender already verified in Resend and store its address as `HOMELAB_AUTH_EMAIL_FROM`.
Production sender delivery must be tested once before email verification/recovery is enabled
for real accounts. Fake test delivery is not proof that Resend accepts the real domain.

The Resend rename/reference step was completed and verified on 2026-09-15 with the operator's
new temporary Doppler login. `prd.HOMELAB_AUTH_RESEND_API_KEY` owns the value;
`apps_homelab_auth.HOMELAB_AUTH_RESEND_API_KEY` references it. The legacy `prd.RESEND_API_KEY`
is only a reference for old consumers, not a duplicate secret. The separate
`apps_homelab_dashboard` config exists without Resend access. New auth/database/cookie/signing
keys and dashboard credentials are prepared, and both app scopes resolve their complete runtime
key inventory. Database provisioning, sender qualification and deployment remain production gates.
The earlier missing local CLI login was not evidence of a known token-expiration period.

## Database and keys

Provision a dedicated auth database and owner, not PostgreSQL superuser access or an app's
existing database. Production requires `sslmode=verify-full`, trusted CA roots and matching
server name. Native Bun SQL uses up to eight connections. Prepared statements remain enabled:
`prepare:false` with this Drizzle RC failed JSONB array writes in a real test.

Prefer direct PostgreSQL for this small identity pool. If using PgBouncer, separately test
prepared-statement support/session pooling, ownership, migrations and reconnection. Do not
silently change the project's SQL driver options to accommodate an unqualified pool.

Generate independent random material with `bun run auth:admin generate-keys` **only in a private
operator terminal or a protected pipe to the secret manager**. Its JSON output contains private
keys; never paste it into an issue, chat or CI log. It generates the data key, cookie key, proxy
key, RSA JWKS and dashboard session key. Set `HOMELAB_DASHBOARD_OIDC_AUTH_METHOD` to match the dashboard client's
`token_endpoint_auth_method` in `HOMELAB_AUTH_CLIENTS`: `client_secret_post` (default) or
`client_secret_basic`. Both are exercised through the complete BFF login tests.

Each OIDC client also needs its own random secret
(at least 32 characters). Do not reuse the shared human web password.

Apply reviewed migrations explicitly:

```sh
bun run auth:admin migrate
```

Inside the auth image, the equivalent is `bun --no-env-file admin.js migrate`. The image includes
its migration artifacts. Web startup never applies schema changes. Create the first operator
with `auth:admin create-user`, supplying private JSON on stdin:

```json
{
    "username": "operator",
    "email": "operator@example.test",
    "password": "<private password>",
    "groups": ["admins"]
}
```

Replace placeholders privately. Passwords do not belong in shell arguments/history. This is
not an example to copy into a shared terminal log. The optional `id` field is a UUID reserved
for an approved account-linking migration. Email starts unverified.
Account creation also queues the first verification email atomically. The running auth
worker delivers it through Resend with normal retries. Its link expires after 30 minutes,
only confirms that initial mailbox, and does not sign the user in. Opening the link
submits the proof in the browser and returns to the auth entry page with a success notice;
no additional Verify button is required.

Recovery uses the same private-stdin pattern with `username` and `password`:
`auth:admin recover-user`; add `--reset-mfa` only when approved. It revokes sessions and pending
proofs and records an operator recovery event. It does not silently disable MFA.

## Backup, recovery and rotation

Use the existing PostgreSQL/PBS backup system. Include the auth schema, migrations/release
reference and independently recoverable encryption/signing keys from Doppler. Database files
alone cannot decrypt factors or protocol state without the data key. Do not add one-off
production dumps, Kopia or another parallel backup job.

Restore into an isolated database first, with the matching keys and no outbound email/client
traffic. Verify account records, factor payload readability and a synthetic login. Decide
explicitly whether restored sessions are revoked before service resumes. Never restore an old
identity database over a live one as a casual application rollback.

The supported offline data-key rotation command processes all six encrypted record types in
bounded batches within one PostgreSQL transaction. Password hashes, account IDs, factors and
their metadata are preserved. A corrupt record, wrong old key, or failed verification aborts
the whole operation; the database remains encrypted with the old key. Tests cover more than
one batch, every encrypted column, rollback and rotation back to the original key.

1. Take the normal verified PBS backup and retain its matching old key securely.
2. Stop **all** auth replicas, background workers and administrative writers. Rotation is an
   offline maintenance operation; table locks protect the transaction, not an old process
   restarted with the wrong key after commit.
3. Keep the current `HOMELAB_AUTH_ENCRYPTION_KEY` injected. Supply private JSON on stdin:
   `{ "nextEncryptionKey": "<new random 32-byte base64 key>" }`.
   Do not put keys in command arguments, repository files, chat or logs.
4. Run `bun run auth:admin rotate-data-key --check`. It verifies every candidate without
   modifying records.
5. With services still stopped, supply the same private input to
   `bun run auth:admin rotate-data-key --service-stopped`. This commits the verified
   re-encryption atomically and reports only per-table counts.
6. Update the canonical Doppler data key to the new value **before restarting any auth
   process**, then verify readiness, TOTP/WebAuthn and normal login. These are two operational
   steps: PostgreSQL and Doppler cannot be committed as one transaction. If secret publication
   fails, leave services stopped, retain both keys and resume publication or rotate back.
   Never start the old key against the newly encrypted database.

The old key remains necessary for pre-rotation PBS backups. Do not delete it until their
retention has elapsed. Existing encrypted ForwardAuth cookies become invalid and re-enter SSO;
persistent MFA enrollment is retained. The dashboard's separate key is not changed.
Cookie/JWE-key replacement logs out affected browsers. For signing rotation, publish old and
new identified public JWKs through the overlap period; qualify which key is selected for new
signatures and do not remove a key while valid tokens still reference it.

## Monitoring

Add private `/health/live` and `/health/ready` probes to the existing VictoriaMetrics/blackbox
setup at deployment. Auth readiness verifies the complete applied migration names and hashes
against the running build; missing, changed or extra migrations return unavailable. Startup
and readiness never apply migrations. The CLI and server share the same migration inventory.
Dashboard readiness checks configured
identity wiring, not every downstream dependency. Also probe a synthetic unauthenticated
protected endpoint for denial, OIDC discovery/JWKS and actual Resend delivery status separately.

Forward bounded stdout/stderr to the existing Loki pipeline. Alert on persistent readiness
failure, `maintenance_failed`, repeated `request_failed` / `identity_request_failed`, `email_delivery_failed`, unexpected
OIDC rejection spikes and failed deployment/migrations. Never ingest credentials or callback
tokens. The existing external Healthchecks/Sentinel arrangement remains unchanged.

## Production gates (not executed by this PR)

1. Review this PR, then qualify Bun/library compatibility and the built images.
2. Finish scoped Doppler references, verified sender, private database/TLS, migration and PBS
   restore test. Build from the reviewed commit; no floating production tag.
3. Use private staging origins and synthetic accounts. Verify password, email, TOTP,
   recovery codes, USB YubiKey, iPhone NFC, cancellation/PIN errors, Settings replay and session
   revocation. A real-browser screenshot is not a replacement for these behavior checks.
4. Inventory existing Authelia clients, exact callbacks, subject/account links, claims/groups,
   ForwardAuth consumers and all public media/mobile/API exceptions. Preserve app UUIDs.
   Re-enroll WebAuthn if the RP ID changes; do not copy encrypted records blindly.
5. Verify client-secret-post and client-secret-basic consumers, refresh/logout behavior,
   expired sessions, proxy header spoofing and deliberate unauthenticated API access.
6. Obtain explicit approval for the actual issuer/routing/account switch. Keep Authelia and
   its normal PBS recovery path available. Switch a test route/client first, then the reviewed
   inventory; no silent DNS-wide replacement.
7. Verify Nextcloud desktop/iOS, AIO clients, CrossWatch, pgAdmin/OpenClaw identity headers,
   video playback, public manifests and local/Mesh access. Confirm monitoring and real email.
8. Roll back route/client configuration to Authelia if acceptance fails. Do not merge two live
   identity stores or promise sessions survive switching providers.

This PR does not perform a production cutover or create a production account. Production
Authelia and its client settings remain unchanged. The separately approved acceptance environment
uses temporary private origins, routing/firewall entries and a disposable database; its test
account may use real Resend delivery for email verification. Those deployment resources are
tracked in the acceptance environment's cleanup inventory, not installed by merging this PR.

## Removing the last security method

Removing one factor while another remains preserves the current session's OIDC grants.
Removing the last factor atomically clears recovery codes, revokes other sessions and
revokes every OIDC grant bound to the current session, including the dashboard grant.
Existing access and refresh tokens cannot be reused or revived by enrolling a new factor.
The central auth cookie stays valid so the user can manage the account and enroll MFA
again. Connected applications must sign in again; non-dashboard clients still require MFA.

## Browser request and WebAuthn boundaries

The private dashboard tRPC API requires same-origin evidence before it validates a session
or records activity. GET requests need `Sec-Fetch-Site: same-origin` or an exact `Origin`;
writes still require the exact `Origin`. Contradictory headers, same-site sibling requests
and unproven GETs are rejected. Passive session polling does not renew the idle deadline.

WebAuthn RP IDs are checked against the Public Suffix List, including private suffixes.
Use an owned domain covering the approved UI origins, not a suffix such as `com`, `co.uk`
or `github.io`. The explicit development mode permits `localhost`; production does not.
The suffix list is bundled in the pinned `tldts` dependency, with no startup network lookup.

## Public resource exceptions

`HOMELAB_AUTH_POLICY_FILE` selects a deployment-owned YAML policy, for example
`/etc/homelab-auth/access-policy.yml` on Edge. Start from
`apps/auth/config/access-policy.homelab.yml`; the file contains a top-level `routes`
list. Keep this non-secret policy in version control, mount it read-only in the auth
deployment and restart auth after a reviewed edit. Secret values remain in Doppler.
The former JSON-valued `HOMELAB_AUTH_ROUTES` is rejected rather than silently ignored.
A missing, malformed, oversized or schema-invalid policy prevents configured startup.
Unknown origins remain denied; an empty list grants no ForwardAuth destinations.
This PR does not install the file on Edge or replace the live Authelia policy.

Each route is a per-origin allowlist for ForwardAuth. `publicPaths` matches exact
paths; `publicPrefixes` matches path-segment prefixes ending in `/`, never the whole root.
Unknown origins are denied. Other paths require a current MFA session and an allowed group.
Encoded ambiguous separators cannot turn a protected path into a public exception.

These exceptions bypass Homelab sign-in only. An app's own manifest/configuration token,
API key or other endpoint checks still apply. Before cutover, inventory the actual Stremio
routes, including token-prefixed paths, and qualify unauthenticated manifests, catalogs,
metadata, streams and subtitles without exposing the configuration/admin pages.
Ordered `resourceRules` support anchored RE2 expressions over the normalized URL path, not
the query string. The first matching rule wins: `bypass`, `two_factor`, or `deny`. Place
admin restrictions before broader public API exceptions. RE2 avoids exponential backtracking.
No match defaults to MFA and the route's groups; unknown origins are denied. YAML `&admin`
defines a reusable rule and `*admin` reuses it, rather than acting as a wildcard.

The Homelab file was translated from **active generated** Authelia configuration on Edge on
2026-09-15, including its effective `admins` policy. It contains 15 origins, token-prefixed
media exceptions, exact Hydra paths and explicit admin restrictions. It has not been activated
as the production policy on Edge. Attach ForwardAuth to each protected Traefik router; a policy cannot protect a service
whose router bypasses the middleware. Do not wrap the auth service in its own login middleware:
its public login/OIDC endpoints and authenticated account APIs enforce their own boundaries.

## Recovery queue and passive account reads

Account snapshots never extend session activity, whether reached through the dashboard
BFF or directly on auth. Authenticated same-origin tRPC work and successful security
operations remain active; passive polling cannot defeat idle expiry.

Password-reset requests always enqueue the same encrypted job before responding.
Account lookup and recovery eligibility are evaluated by the existing maintenance worker,
not on the public request's timing path. Unknown and unverified accounts produce no email.
Proof emails reference their challenge with a cascading foreign key; replacing, consuming
or revoking that challenge also removes its queued message, including delayed retries.
Deploy the generated schema migration before starting the updated service.

## OIDC logout delivery and client qualification

Clients opt in with both `backchannel_logout_uri` (exact HTTPS endpoint) and
`backchannel_logout_session_required: true`. Optional `groups` defaults to `["admins"]`.
A fresh grant gets a fresh protocol SID. Signed logout tokens are produced by the pinned
oidc-provider implementation with issuer, audience, issued time, event, JTI, subject and SID;
they contain no nonce. Settings revocation, recovery, expiry and confirmed RP logout revoke
central grants and atomically enqueue encrypted notifications.

The maintenance worker processes at most five messages per pass, with exponential retry from
15 seconds up to five minutes and a 24-hour expiry. Downstream failure never restores central
access. Native RP logout may also send immediately; delivery is **at least once**, so receivers
must accept repeated SID invalidation. A changed/removed endpoint is not sent old session data.
Watch `oidc_logout_delivery_failed` and `oidc_logout_delivery_expired`; an expired delivery
requires operational attention, not a claim that the remote application logged out.

Only registered exact logout endpoints may receive outbound OIDC POSTs. Redirects are not
followed. Dynamic registration and remote client metadata/JWKS are not enabled. Private LAN
destinations are intentionally allowed only through this operator-managed endpoint inventory;
the Node-specific undici SSRF dispatcher is not relied upon under Bun.

The dashboard BFF has no independently authorized server-side session: it checks central
state on every protected request. It does not need a redundant logout receiver or local
revocation database. A stale browser cookie cannot grant continued access.

Prepared Doppler clients preserve the current AIOStreams, AIOMetadata, CrossWatch and Nextcloud
client IDs, callback URIs, client-secret auth methods and original secret references; the
dashboard gets a new independent client. No live consumer has been switched. Back-channel
endpoints must be enabled only after testing the installed client receiver and subject/SID
mapping. The installed Nextcloud `user_oidc` app exposes
`/apps/user_oidc/backchannel-logout/{providerIdentifier}`; select the actual new provider's
identifier during qualification, not a guessed URL or one still bound to Authelia. Native
mobile app-password/token revocation is a separate client-specific policy, not promised by
OIDC browser logout.

## Prepared Doppler expressions

Canonical credentials remain single values in `prd`. App configs reference only their required
leaf values. Doppler does not resolve references to another reference expression, so database
URL, auth client JSON and the three cross-app name/origin expressions live directly in their
consuming app scope and refer to canonical leaves. The five redundant, newly created `prd`
expressions were removed only after equal-value checks, with operator approval. Existing
Authelia secrets and consumer credentials were neither rotated nor deleted.

The prepared direct PostgreSQL URL names the dedicated `homelab_auth` database/role.
Preparing a URL does **not** provision that database. The dashboard origin is prepared as
`https://dashboard.home.rajohan.no`; DNS, TLS routing and deployment remain separate acceptance
steps. No application currently consumes these new production scopes.

## Initial schema history

The unreleased auth schema is shipped as one `20260915120404_initial_auth` migration,
generated from the complete schema, including remembered sessions and account-owned OIDC
approvals. The operator approved discarding the isolated acceptance database and its test
accounts before this final consolidation. No production database has used these migrations.

Fresh databases apply this one migration. Any earlier preview database must be removed or
recreated; do not rewrite its migration journal to claim the new schema. Once deployed to
production, preserve this migration and add reviewed incremental migrations for later changes.

## Configurable session lifetimes

Set these nonsecret values in the scoped auth deployment environment (or its Doppler config), then
restart auth. No build or source edit is required. Dashboard and ForwardAuth follow central validity.

| Variable                                     | Default | Meaning                            |
| -------------------------------------------- | ------- | ---------------------------------- |
| `HOMELAB_AUTH_SESSION_MAX_AGE_SECONDS`       | 43200   | Normal session: 12 hours absolute  |
| `HOMELAB_AUTH_SESSION_IDLE_TIMEOUT_SECONDS`  | 3600    | Normal session: one hour inactive  |
| `HOMELAB_AUTH_REMEMBER_MAX_AGE_SECONDS`      | 2592000 | Remember me: 30 days absolute      |
| `HOMELAB_AUTH_REMEMBER_IDLE_TIMEOUT_SECONDS` | 604800  | Remember me: seven days inactive   |
| `HOMELAB_AUTH_STEP_UP_MAX_AGE_SECONDS`       | 300     | Fresh security proof: five minutes |

Remember me is an explicit choice at password sign-in, off by default; it never skips enrolled MFA.
Absolute expiry does not slide. Passive session polling does not count as activity. Bounds are checked
at startup: idle cannot exceed absolute expiry, remembered limits cannot be shorter than normal ones,
and step-up is between 30 seconds and one hour, no longer than normal idle. Absolute limits are capped
at 30 days. Shortening a policy also restricts existing sessions; increasing it does not extend an
already stored absolute expiry or cookie. A new login adopts the new full lifetime.

Approved applications are separate from Remember me. Consent persists per account across logouts,
until revoked in Settings or superseded by recipient/permission changes. All registered clients
require initial approval, including dashboard; client registration alone grants nothing.
