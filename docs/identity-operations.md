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
`apps_homelab_dashboard` config exists without Resend access. Remaining runtime database,
client and signing keys, sender qualification and actual deployment are still production gates.
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

The data-encryption key currently has one active version. Its rotation needs a reviewed,
transactional re-encryption migration; changing the environment variable is not rotation.
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

This PR creates no production account, sends no real email, installs no new DNS/certificate
job and does not change current Authelia, Traefik, firewall or OIDC client settings.

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
`apps/auth/config/access-policy.example.yml`; the file contains a top-level `routes`
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
The current path/prefix model does not support arbitrary regular expressions. If a current
Authelia rule needs more expressive matching, extend and test the model before migrating
that route; never replace it with a root-wide bypass.

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
