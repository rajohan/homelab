# Mira AgentMail integration

The repository owns the webhook receiver, bounded read adapter, catch-up cursor,
product tools and integration controls. Svix is pinned in `apps/mira/package.json`
and follows the existing Bun/Dependabot release workflow; hosted AgentMail service
updates are provider-owned. No third-party patch or OpenClaw hook is required.

## Provisioning

Supply the same `HOMELAB_MIRA_AGENTMAIL_OWNER` (Homelab account ID) and
`HOMELAB_MIRA_AGENTMAIL_INBOX` to dashboard and Mira. The binding is operator-owned;
model arguments cannot replace it. Inject credentials privately:

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
The executor reads at most one 100-message page per recovery cycle, normally checks
once per minute, and retains a fixed window and fenced cursor through restarts.
Recovery is bounded to the latest 24 hours, with a one-minute overlap. Failed or
expired page tokens restart that same window; accepted events remain deduplicated.
Downtime beyond that window requires a deliberate manual inbox review.

Disabling AgentMail stops new provider reads. A request already in flight cannot
be undone, but its result is discarded if the control changed before acceptance.
Recovery does not enqueue messages from deliberate pauses or before activation.
Pausing one mail automation stops only that automation; global automatic-work pause
prevents automatic dispatch. Receipts and pause reasons remain available.

`mira_mail_list` and `mira_mail_read` are fixed-origin read-only tools. They recheck
account binding, the integration control and the current run lease before and
after provider access. Metadata listing is bounded to 100 messages and a 31-day
window per request; message text is limited to 48,000 characters. HTML is passive
text; remote images and attachments are not fetched. Spam, blocked, unauthenticated
and trashed messages are excluded. Mail content cannot authorize actions.

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
retrying an existing window and pause races before returning mail content. A real
provider activation still needs scoped credentials and a verified inbox binding.

References: [webhook contract](https://docs.agentmail.to/webhooks-overview),
[signature verification](https://docs.agentmail.to/webhook-verification),
[message listing](https://docs.agentmail.to/api-reference/inboxes/messages/list).
