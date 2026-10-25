# Moltbook reads

Mira can read its provisioned Moltbook profile, personalized feed and selected posts. These tools are available to manual and enabled automatic runs through the existing discovery router and durable call receipts. They cannot publish, vote, follow accounts, send direct messages or acknowledge notifications. A read is not a subscription to new activity and does not add a polling job.

## Provisioning and controls

Supply the same `HOMELAB_MIRA_MOLTBOOK_OWNER` (Homelab owner ID) and `HOMELAB_MIRA_MOLTBOOK_AGENT_NAME` to dashboard and Mira. Only Mira receives `HOMELAB_MIRA_MOLTBOOK_API_KEY`; the isolated model child receives none of these provider credentials. Existing credentials are not discovered from legacy directories. The compose overlay exposes these explicit settings; leave them absent until qualification.

The existing Integrations card shows Moltbook and supports its own enable/pause control, reason and optional resume time. Enabling requires a matching fresh executor binding. Each read rechecks the confirmed account, fresh dashboard binding, control version and execution lease before and after provider access. A pause cannot recall a request already sent; its response is discarded if access changed. A replacement account requires renewed operator consent. Timed resume retains the previous binding and requires fresh matching dashboard/executor evidence. Pausing Moltbook does not pause chat or other integrations.

## Provider contract

Requests use GET on `https://www.moltbook.com/api/v1/`, with redirects disabled and a fixed credential header. Account identity is checked using `agents/me`; only the configured agent name is accepted. `feed` returns at most 25 excerpts and an opaque continuation; `posts/{id}` accepts an identifier, not a URL. Response bodies have a 2 MiB limit and each request a 15-second deadline. Profile descriptions, feed excerpts and post content are bounded. Private owner fields, credentials and provider instructions are not projected into results; visible social text remains untrusted data. No linked images or pages are fetched. `/home` is deliberately not used because its check-in changes activity/briefing state.

Read failures produce a redacted retryable tool result and do not mark unrelated work as an uncertain external mutation. Provider/service availability does not imply that an account credential is valid; the first read verifies it. The adapter follows the official [Moltbook API contract](https://www.moltbook.com/skill.md), inspected at version 1.12.0. This reference is API evidence, not permission to download or execute changing remote instructions.

The adapter ships with Homelab's existing versioned builds and updates. There is no separate locally installed package or runtime patch. Synthetic tests cover account mismatch, passive projection, input/response bounds, pauses, regrant during reads, receiver replacement, lease loss, retry receipts and timed resume. Production credential/identity qualification remains part of deployment; no live account was activated during development.
