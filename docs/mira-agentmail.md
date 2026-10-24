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
- Mira receives only `HOMELAB_MIRA_AGENTMAIL_API_KEY`, scoped to reading the selected
  inbox. The native model child does not inherit this credential.

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

Sending/replying, attachment ingestion and reviewed outgoing drafts are separate
remaining deliveries; this adapter cannot send mail.

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

Pending Agent Armor Monitor scans are deferred at webhook acceptance. Recovery retains
its page checkpoint and retries after 30 seconds until scanned metadata becomes
eligible; unavailable/review verdicts remain excluded. A pending scan can delay its
recovery page, while already accepted webhook messages continue independently.
Release/event freshness is stored separately from original receipt-time pause
eligibility, so a newly released older message can be reviewed without reviving mail
received during a deliberate pause. Read-only provider failures remain retryable and
do not fence unrelated product tools as uncertain external mutations.

Recovery only admits received-label additions and held-label removals backed by a
release override. Unrelated label changes never refresh a message's availability;
ordinary received mail retains its original receipt age.

### Outgoing draft review and delivery

The chat's **Email drafts** library stores editable, owner-scoped plain-text drafts locally. Mira can propose a draft during a manual conversation but cannot approve or send it. Automatic mail-triggered work does not have draft-write permission. The review dialog displays the configured inbox, every To/Cc/Bcc recipient, subject and body before **Confirm and send**. The approval binds the current version, normalized content hash, inbox binding and integration-control version. Changes require a fresh review.

The executor claims a queued draft once before invoking the official [AgentMail send-message API](https://docs.agentmail.to/api-reference/inboxes/messages/send). Each attempt disables redirects and uses a fixed provider origin and bounded timeout/response. A verified provider acknowledgement means accepted by AgentMail, not delivered to the recipient. A network loss, rejection or malformed response leaves **Needs attention** without automatic retry; inspect the provider inbox before deliberately preparing a new send. A late verified acknowledgement can refine an abandoned attempt to accepted.

Approval expires after fifteen minutes before dispatch. Disabling/re-enabling the integration or changing its inbox binding returns queued work to draft for another review. Already-started provider calls cannot be recalled by pausing. The receiver and executor must agree on the inbox before approval/dispatch. Cancellation is available only before dispatch; it does not claim to unsend mail. Repeated approval requests return the same queued/sent/unknown record and cannot send a second copy.

This first outgoing implementation handles new plain-text messages. Threaded replies and outgoing attachments are not yet implemented. No actual inbox or outgoing provider transport is activated by a development preview.

### Mail-triggered workload limits

Limits are shared by all inbox bindings and automatic subscribers for one owner: at most 60 new event references per rolling hour, 250 per rolling day and 1,000 retained references. Server receipt time controls metering, independently of provider timestamps. Verified duplicate deliveries do not consume additional event allowance. Deliberately paused mail remains bounded and does not generate quota notifications. References and delivery metadata expire after seven days; cleanup runs independently of provider availability. Older replayed receipt events are not reinserted after cleanup.

One event can feed at most ten currently eligible subscribers. Automatic mail work shares a rolling allowance of 24 runs and 1,800 reserved execution seconds per day; each run is capped at 120 seconds even if an automation requests more. Queued and failed runs count, so cancellations cannot refund an attacker-controlled burst. These are execution allowances, not a promise about token usage or API cost. Ordinary user chat and other automation triggers retain their own admission.

Excess triggers or deliveries are skipped, not accumulated into a later burst. Messages remain in AgentMail for manual review. The owner gets at most one private notification per quota category per UTC day while mail processing is enabled. This first version uses repository-defined limits; changing them is a reviewed configuration/code change.
