# Mira AgentMail integration

The repository owns the webhook receiver, bounded read adapter, catch-up cursor,
product tools and integration controls. Svix is pinned in `apps/mira/package.json`
and follows the existing Bun/Dependabot release workflow; hosted AgentMail service
updates are provider-owned. No third-party patch or OpenClaw hook is required.

## Provisioning

Supply the same `HOMELAB_MIRA_AGENTMAIL_OWNER` (Homelab account ID) and
`HOMELAB_MIRA_AGENTMAIL_INBOX` to dashboard and Mira. The binding is operator-owned;
model arguments cannot replace it. The executor publishes a non-secret binding fingerprint,
and the dashboard requires an exact match before activation. An inbox change
requires pausing and enabling the integration again; mismatches block reads and
return a retryable webhook failure. Inject credentials privately:

- Dashboard receives only `HOMELAB_MIRA_AGENTMAIL_WEBHOOK_SECRET`, the webhook's
  own Svix signing secret.
- Mira receives `HOMELAB_MIRA_AGENTMAIL_API_KEY`, scoped to reading the selected inbox.
- Outgoing delivery additionally requires `HOMELAB_MIRA_AGENTMAIL_SEND_API_KEY`,
  scoped to `message_send` for that same inbox under the provider's
  [permission model](https://docs.agentmail.to/permissions). Keep the read key read-only.
  Missing send credentials disable approval and dispatch while incoming mail continues.
  Neither credential is sent to the dashboard or inherited by the native model child.
  Before activation, verify the send key's inbox and permission restrictions in AgentMail;
  a synthetic development credential does not establish live send permission.

`deploy/compose.mira.yaml` declares the separated environment delivery. Register
only `message.received` for the selected inbox at
`https://dashboard.example.test/api/mira/hooks/agentmail`. This exact POST route
uses signature verification rather than browser login; every private dashboard
route keeps its existing authentication. Configure the proxy to forward the raw
body and `svix-id`, `svix-timestamp`, `svix-signature` without a login redirect.
Unsigned, expired or oversized deliveries are rejected; database failures return
503 so the provider can retry. The receiver acknowledges after the event commits.

Enable AgentMail in Automations → Integrations and enable a separate automation
with the AgentMail message trigger. New controls and automations are paused.
Availability shows configuration and executor freshness; successful recovery is
recorded separately. No real credentials, hooks or mail subscriptions are activated
by installing this code.

## Delivery and pause behavior

A signed delivery stores only the inbox/message reference, not an untrusted body.
A stable inbox/message key deduplicates webhook retries and periodic recovery.
The executor reads at most one 25-event page per recovery cycle and normally checks
once per minute. A durable page cursor and the first page's head event ID survive
restarts. Recovery follows the provider's event-ID ordering and stops at its last
completed event identity, never inferring order from sender or creation timestamps.
Initial activation, or loss of the saved event from provider retention, requires
one bounded pass to establish a checkpoint; subsequent windows scan only new events.
It fetches current metadata for up to 25 unique messages with at most five requests
in flight and a 30-second page budget. Event creation time limits catch-up to the
latest 24 hours. A fresh release event can recover an older held message: the original
message receipt time is retained separately for activation and pause eligibility.
Failed or expired page tokens restart the pending pass; accepted deliveries remain
deduplicated. Held messages remain excluded until their current label is removed.
Downtime beyond that window requires a deliberate manual inbox review.

Disabling AgentMail stops new provider reads. A request already in flight cannot
be undone, but its result is discarded if the control changed before acceptance.
Recovery preserves its last successful boundary across pauses. Enabled intervals
are recorded separately, so mail received before a pause remains recoverable while
mail received during the pause or before activation is excluded. Delayed webhooks
received during a pause retain their event; recovery can add historically eligible
missing deliveries after resumption without replaying dispatched or deliberately
cancelled deliveries. Timed resume requires fresh dashboard receiver and executor evidence matching the
previously confirmed binding; a configuration mismatch keeps the integration paused.
A replacement inbox starts at its explicit activation, even
when the first recovery poll happens later.
Pausing one mail automation stops only that automation; global automatic-work pause
prevents automatic dispatch. Receipts and pause reasons remain available.

`mira_mail_list` and `mira_mail_read` are fixed-origin read-only tools. They recheck
account binding, the integration control and the current run lease before and
after provider access. Metadata listing is bounded to 100 messages and a 31-day
window per request; message text is limited to 48,000 characters. HTML is passive
text; remote images and attachments are not fetched. Spam, blocked, unauthenticated
trashed and `agent-armor-held` messages are excluded. When Agent Armor metadata is
present, pending/unavailable scans and review verdicts without a recorded human
release are also excluded, including before the held label has appeared. Mail content cannot authorize actions.

Received-mail tools remain read-only. The separate reviewed outbox below can send new
plain-text messages and reviewed replies with its dedicated credential. Incoming
attachment ingestion remains a separate delivery.

Provider declarations use stable discovery and invocation tools. Each resumed
conversation receives the current trusted server instructions and resolves the
current tool registry. Conversations created with the stable router can discover
new integrations without a new conversation. Pre-router provider threads retain
their original catalog and use compatible current direct handlers; their stored
history and tool access remain intact, but newly added tools require a new chat.
Underlying tools still enforce their own input schemas, owner, grants and durable
call receipts.

## Verification

Synthetic tests cover raw-body signatures, time tolerance, wrong-inbox rejection,
bounded HTTP responses, owner isolation, durable deduplication, interrupted paging,
retrying an existing window, repeated-pause recovery, empty extracted-body fallback,
cross-service binding mismatches and pause/resume races before returning mail content. A real
provider activation still needs scoped credentials and a verified inbox binding.

References: [webhook contract](https://docs.agentmail.to/webhooks-overview),
[signature verification](https://docs.agentmail.to/webhook-verification),
[message listing](https://docs.agentmail.to/api-reference/inboxes/messages/list),
[inbox events](https://docs.agentmail.to/api-reference/inboxes/events/list),
[Agent Armor](https://docs.agentmail.to/agent-armor).

Pending Agent Armor Monitor scans are deferred at webhook acceptance. Recovery commits
clear messages and its feed cursor while storing pending/unavailable scan references
separately. Each cycle revisits up to ten references in rotating order alongside the
next feed page, so a busy inbox cannot starve already-clear mail. At most 1,000 scan
references are retained for 24 hours; excess references remain in AgentMail for manual
review. No body is stored and rejected verdicts remain excluded.
Release/event freshness is stored separately from original receipt-time pause
eligibility, so a newly released older message can be reviewed without reviving mail
received during a deliberate pause. Read-only provider failures remain retryable and
do not fence unrelated product tools as uncertain external mutations.

Recovery only admits received-label additions and held-label removals backed by a
release override. Unrelated label changes never refresh a message's availability;
ordinary received mail retains its original receipt age.

### Outgoing draft review and delivery

The chat's **Email drafts** library stores editable, owner-scoped plain-text drafts locally. Mira can propose a draft during a manual conversation but cannot approve or send it. Automatic mail-triggered work does not have draft-write permission. The review dialog displays the configured inbox, every To/Cc/Bcc recipient, subject and body before **Confirm and send**. The approval binds the current version, normalized submitted-content hash, inbox binding and integration-control version. Changes require a fresh review. The review also discloses AgentMail’s provider-added “Sent via AgentMail” footer on the free plan; paid plans omit it, as documented in [AgentMail Messages](https://docs.agentmail.to/messages). The hash covers the submitted content, not provider-added formatting. Existing owner-scoped drafts remain editable after deletion of their source chat; their retained link records provenance and cannot be reassigned to another deleted or unowned chat.

The executor claims a queued draft once before invoking the official [AgentMail send-message API](https://docs.agentmail.to/api-reference/inboxes/messages/send). Each attempt disables redirects and uses a fixed provider origin and bounded timeout/response. It includes a stable `Idempotency-Key` per draft, following the provider's [24-hour send deduplication contract](https://www.agentmail.to/docs/idempotency); durable local claims still prevent automatic retries after uncertain results or after that retention expires. The contract validates the provider's combined 50-recipient limit before saving or approving. A verified provider acknowledgement means accepted by AgentMail, not delivered to the recipient. A network loss, rejection or malformed response leaves **Needs attention** without automatic retry; inspect the provider inbox before deliberately preparing a new send. A late verified acknowledgement can refine an abandoned attempt to accepted.

Approval expires after fifteen minutes before dispatch. Disabling/re-enabling the integration returns same-inbox queued work to draft for another review. Removing or changing the inbox cancels obsolete approvals before sending. Already-started provider calls cannot be recalled by pausing. The receiver and executor must agree on the inbox before approval/dispatch. Cancellation is available only before dispatch; it does not claim to unsend mail. Repeated approval requests return the same queued/sent/unknown record and cannot send a second copy.

Outgoing messages support up to five explicitly selected uploaded files totaling 4 MiB. The server snapshots each owned file's name, MIME type, size and digest into the reviewed content hash. Files must still exist unchanged at approval and dispatch. The request embeds verified bytes as base64 and enforces the provider's 6 MB serialized request limit; arbitrary download URLs are never accepted. Local verification failure returns the email to draft without a provider request. A model can propose only files already shared in its current conversation. The operator can choose from their own file library and remove files before saving. Incoming attachment ingestion remains outstanding. No actual inbox or outgoing provider transport is activated by a development preview.

### Mail-triggered workload limits

Limits are shared by all inbox bindings and automatic subscribers for one owner: at most 60 new event references per rolling hour, 250 per rolling day and 1,000 retained references. Server receipt time controls metering, independently of provider timestamps. Verified duplicate deliveries do not consume additional event allowance. Deliberately paused mail remains bounded and does not generate quota notifications. References and delivery metadata expire after seven days; cleanup runs independently of provider availability. Older replayed receipt events are not reinserted after cleanup.

One event can feed at most ten currently eligible subscribers. Automatic mail work shares a rolling allowance of 24 runs and 1,800 reserved execution seconds per day; each run is capped at 120 seconds even if an automation requests more. Queued and failed runs count, so cancellations cannot refund an attacker-controlled burst. These are execution allowances, not a promise about token usage or API cost. Ordinary user chat and other automation triggers retain their own admission.

Excess triggers or deliveries are skipped, not accumulated into a later burst. Messages remain in AgentMail for manual review. The owner gets at most one private notification per quota category per UTC day while mail processing is enabled. This first version uses repository-defined limits; changing them is a reviewed configuration/code change.

Queued approval reconciliation runs even when AgentMail credentials are absent. Expired approvals and access changes return same-inbox drafts for fresh review; removed or changed inboxes cancel the obsolete draft before sending, retaining its original inbox and content for inspection. The operator creates a new draft explicitly when needed; no approval or content is silently rebound to another sender.

Quota suppression is durable. An owner-wide receipt-time watermark skips quota-rejected mail and earlier unseen mail even after an hourly allowance resets or a security scan later releases it. Existing recorded events retain their own delivery receipts. The watermark uses one row per account, so an inbox flood cannot grow a tombstone table. Messages remain available for manual inbox review.

Trusted Mira instructions are hashed with each provider thread. When the hash changes (or a legacy thread has no hash), the executor retires that provider thread before rebuilding bounded conversation history from product messages under the new instructions. Failed deletion retains the old reference for retry; it never resumes with an unverified policy. An offline native Codex 0.164.0 probe confirmed that cold resume sent policy A to the mock Responses endpoint after accepting policy B, so this workflow does not rely on that override reaching the model.

### Reviewed replies in existing threads

In manual chat, `mira_mail_reply_draft_create` reads an eligible received message from the configured inbox before creating a local reply draft. Every recipient must be supplied explicitly; automatic mail-triggered work cannot create replies. The server retains the original message/thread identity, sender and subject in the approved content fingerprint. Editing keeps this reference immutable, and the review shows the original sender and full thread subject. The editor's bounded subject preview cannot change the provider-owned thread subject.

Dispatch uses AgentMail's [reply endpoint](https://docs.agentmail.to/api-reference/inboxes/messages/reply) with explicit To/Cc/Bcc lists and `reply_all: false`; no subject or unreviewed custom headers are submitted. The provider response must identify the expected thread before the dashboard records acceptance. Unknown results remain for review and are never automatically resent. Durable local claims provide retry protection for replies without assuming the provider's send-only deduplication contract covers the reply endpoint. The free-plan footer disclosure applies to replies too.

Editing an automation into or out of an event subscription resets that automation's receipt-time eligibility and skips its pending deliveries. Older messages cannot be replayed into a newly selected subscription. Ordinary prompt/title edits preserve the subscription. Existing pause reasons and audit receipts remain intact.

Outbox reconciliation also honors the receiver's last explicitly published binding. A removed or replacement dashboard inbox cancels obsolete unsent drafts even while the executor still has its old configuration. An offline receiver with the same binding is a temporary availability problem and does not cancel drafts.

The dashboard receiver is authoritative during rolling configuration changes. Drafts for its current inbox remain editable while an older or temporarily absent executor catches up; the old executor cannot claim or cancel those approvals. An empty optional send-key environment value enables read-only operation, while malformed nonempty keys are rejected.

Attachment approvals include the exact attachment metadata rendered by the review dialog. An old browser bundle cannot approve an attachment-bearing draft using only its opaque content hash; it must reload and show the filenames, detected media types and sizes first.

Reply reads expose original Reply-To, To and Cc routing headers. The draft retains Reply-To for human review without inferring additional recipients. Draft creation and dispatch verify the thread's latest message through the bounded thread endpoint. A reply overtaken by a new message is cancelled before sending; create and review a new reply for that context. Thread lookup failures (including timeouts, missing messages and invalid responses) retain the queue entry without claiming a send or stopping the executor. A later pass retries the read only while the existing approval remains valid; service shutdown still interrupts the operation. Provider message and thread IDs remain available even when an acknowledgement reports an unexpected thread.

Reply approval also requires the exact original reply context rendered by the dialog, so a pre-reply browser bundle must reload before approval. A provider message can still arrive after the final thread check; AgentMail offers no atomic conditional-reply operation.
