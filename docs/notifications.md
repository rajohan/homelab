# Notifications

The dashboard inbox is separate from Alertmanager, Pushover and the identity email outbox. It
does not install a second push pipeline or change existing delivery. The header bell reads only
counts until opened; the panel provides server-filtered read state and severity, virtualized
cursor history, per-item read/unread/dismiss and bounded bulk actions.

`server/notifications/publish.ts` is the producer boundary. A source and stable source key identify
an immutable event; identical replays return the existing ID, conflicting content is rejected.
Titles/messages are bounded plain text. Destinations are fixed dashboard sections, not arbitrary
URLs. Publication requires the caller's active transaction; the automation endpoint opens its own.
A database-local transaction lock serializes sequence allocation through commit, so a delayed
producer cannot appear beneath a newer, already visible bulk cutoff. Rollback releases the lock
without publishing an event. Tokens with
`notifications:publish` may publish through the automation API; their source is fixed to their
account identity. Reading requires `notifications:read`; personal acknowledgements are human-only.

`dashboard_notifications` stores producer events. `notification_receipts` stores read/dismissed
state per operator. Dismissal preserves a receipt so a producer replay cannot resurrect an event.
Bulk actions capture a database-generated publication sequence boundary and process 100 records
per transaction; later publications are not consumed even when producer clocks differ. UUIDs
remain event identities only: newest-first pagination and cursors also use publication order,
so producer clock skew cannot hide new events below old pages. Each batch reads one extra matching
record to distinguish a full final batch from actual remaining work. UI processing stops after
10,000 records, showing continuation instructions only if matching records remain. Counts are
always server-derived, never guessed from loaded pages.

Final manual job outcomes and final scheduled failures/timeouts publish once with the run ID.
Retries do not emit premature failures; regular successful scheduled runs do not flood the inbox.
Application host availability publishes on transitions, not on every poll. Other integrations
can call the same producer without coupling themselves to React or a delivery provider.

Notifications and their receipts follow `HOMELAB_DASHBOARD_JOB_RETENTION_DAYS` (default 30 days).
Hourly maintenance drains expired notifications in independently fenced 1,000-row transactions,
checking cancellation between batches. Its job deadline bounds each run; committed batches remain
removed if a deadline or lease loss interrupts the remainder, which a retry can continue.
Idempotency is guaranteed within that retention window, not after an event has been purged.
The inbox is currently an administrator workspace: read-capable principals can read operational
events, so producers must never include credentials, payload secrets or private identity data.

Verification covers immutable publication, per-operator receipts, filtered keyset pages, bounded
clock-skew-safe bulk cutoffs, concurrent commits and rollback, exact 100/10,000/10,001-record batch
boundaries, multi-batch retention and lease loss, capabilities, retries and atomic final outcomes
against disposable PostgreSQL.
