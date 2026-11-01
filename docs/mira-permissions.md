# Chat permissions

Chat settings stores a permission mode per conversation on the server. Web and Windows use the same setting, contracts, tools and queues. Existing and new conversations default to **Ask for approval**; changing model or provider preserves the mode. Task work in a linked conversation uses that conversation's setting.

| Mode             | Task changes                   | Code jobs                                                               | Email and publication                                                                          |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Ask for approval | Review exact proposals in Chat | Approve each saved job                                                  | Approve each saved draft                                                                       |
| Approve for me   | Apply requested task changes   | Run fixed Homelab source, edit and test profiles on the selected target | Separate approval required                                                                     |
| Full access      | Apply requested task changes   | Run jobs allowed by the selected target                                 | Execute requested drafts through enabled AgentMail, Moltbook, here.now and GitHub integrations |

Main accepts fixed Homelab profiles only. Daytona also accepts arbitrary sandbox commands under Full access. Code jobs retain the selected target's admission limits, idle cleanup and existing resource limits. Daytona consumes subscription credits. GitHub publication creates a tested draft PR using the configured Mira identity; these modes do not merge or deploy.

Permissions cover requested work, not unrelated activity. Integration enablement, pauses, owner bindings, input-file checks and provider qualification still apply. Browser access, PC pairing/local consent, authentication and provider verification retain their separate controls. Automatic runs use their existing explicit grants; Chat modes do not broaden automations or unpause dashboard improvement. Automatic memory maintenance remains governed by the separate memory/history controls.

## Execution and revocation

The selected mode is frozen at run admission. Task tools either create reviewable proposals or apply changes transactionally. `mira_action_execute` accepts a saved draft's kind, ID, version and content hash; the server reads its actual content and requires the same owned conversation. The existing approval functions record the model actor and origin run, then enqueue work. The model never receives a provider credential or impersonates a human approval.

Queued is not completed. Existing outboxes and job workers record outcomes, verify authority before external writes and retain uncertain attempts for inspection instead of repeating them. The origin run may finish successfully before its queued action completes. Cancellation, an interrupted/failed origin, an expired live lease, task stop, archive/deletion or changed permission invalidates delegated authority. Changing permission away and back, or archiving and restoring, does not revive earlier approvals. Direct human approvals and automation grants retain their existing independent rules.

Stop an active Chat run before changing settings. Saving a different permission mode permanently revokes prior runs' delegated approvals in that conversation. Existing integration pause and job cancellation controls remain available. Revocation prevents later work; it cannot undo an external operation that has already been accepted.

## Deployment

The additive migration adds nullable `approval_run_id` references to the five existing action queues and `approval_revoked_at` to runs. Existing rows retain their human/policy approval path; no existing conversation receives broader permissions. Deploy dashboard, Mira and the Main code worker together before offering these modes: older workers do not implement delegated revocation. Do not roll workers back while delegated actions are queued or running; pause/cancel and reconcile those actions first. The migration does not move credentials, change provider grants or activate automations.

Regression coverage uses a disposable PostgreSQL database and fake provider transports: all modes, same-owner/conversation checks, exact versions, stale leases, duplicate tool calls, Main/Daytona classification, queued email delivery, revocation and explicit human approval. Shared component tests cover defaults, all options, disabled controls and preservation of provider/context/target settings.
