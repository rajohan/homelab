# Mira task execution

Tasks keep their requirements and human-managed status separately from each run.
New tasks start only through **Start work**. Moving an already started task from
**Blocked** to **In progress** continues its existing conversation. A finished run
does not automatically mark the task complete.

## Starting and continuing work

Assign an unfinished task to Mira, open its details and select **Start work**.
Optional instructions narrow the next run. Mira receives the saved description,
completion criteria and task reference, and records verified progress through the
same product tools used in Chat. An existing task conversation is reused; an
archived conversation must be restored before work can continue.

The **Work** section shows only this task's runs, with the shared responsive table,
stop action, conversation links and bounded history continuation. **Continue work**
opens another turn in the same conversation. Mobile actions occupy the available
width and task details scroll inside the viewport-bounded shared dialog.

A stable request ID prevents a lost response or double submission from creating
another run. Manual and due-task starts share one task admission lock; a task can
have only one queued or running execution. Completed, blocked or operator-assigned tasks
cannot start through this action. Stop or finish an active run before deleting
its task. Deleting a conversation detaches the task link so a later explicit start
can create a new conversation.

## Uncertain results

After executor loss or unknown tool outcomes, the operator must review the run
before requesting continued work. **Review uncertain run** opens its recorded tool
outcomes; **Mark reviewed** saves a durable acknowledgement without starting a run.
Every uncertain outcome must be reviewed, including multiple runs adopted from an
existing conversation. Original tool receipts are preserved. The review action is
idempotent, and a new uncertain outcome requires its own review. Due-task automation also stays pending until
that review is recorded, subject to the ordinary event expiration window.

## Qualification

Integration tests cover account isolation, concurrent/idempotent starts, run and
task status separation, manual-versus-automatic admission, conversation recovery,
uncertain receipts and task deletion. Component coverage verifies that an uncertain
submission preserves its request identity and input, while review-only acknowledgements cannot start work. The desktop/mobile preview
uses synthetic responses and has no production or provider connection.

Ordinary messages in a task-linked conversation use the same task admission lock and uncertainty gate as explicit task starts. They appear in task execution history and cannot overlap automatic work in another conversation. Review uncertain outcomes from the task dialog first. A conversation shared by multiple tasks must be split into separate task conversations before further work; the server does not guess which task owns a continuation. Identical request retries still return the original run.

The task identity also follows historical task-tagged runs, including separate conversations created by due-task automations. Relinking the task does not turn those chats into unrestricted ordinary conversations. Deleted task context cannot start new work, and ambiguous historical associations require a separate conversation.

Linking a task to an existing conversation atomically adopts its previously unassigned runs. Queued/running work and unresolved outcomes therefore participate in the same admission and recovery checks as explicit task starts. Linking shares the task admission lock and rejects any adoption that would create two active task runs. The editor rejects conversations associated with another live or historical task; old ambiguous records remain blocked until separated.

Upgrade migrations adopt existing unambiguous task/conversation runs, including active and uncertain history. Conflicting live or historical task associations stop the migration with an actionable message; they are never assigned arbitrarily. Reviewing a run records a separate acknowledgement and preserves the task's edit version, so Edit and Delete remain usable immediately afterward.

Generated task turns persist only the task reference and the operator's optional instructions. The executor reads current task details through its scoped tool instead of copying title, description or completion criteria into the conversation. New task conversations use an abbreviated task reference. Legacy migration also adopts runs linked to deleted tasks, so deleting a task cannot leave its old uncertain conversation unrestricted. Ambiguous retained links fail migration closed.

## Change assessments

An enabled **Task created or changed** event automation wakes Mira after human-created tasks, saved edits (including board moves) and progress notes. Five seconds without a newer edit coalesces rapid changes into one assessment of the latest saved task. Changes older than a day and changes made during an intentional pause are not replayed. Deleted tasks, superseded queued assessments and assessments that expire while waiting for a worker are skipped. Partial audit indexes support recent-change discovery and the latest human edit per task without scanning unrelated historical activity.

These runs can read tasks, progress, run outcomes, reports and pause reasons, and save a private report. Their server-provided tool catalog excludes task changes, drafts, external integrations, computer control and code execution. They do not start the task itself: use **Start work** or **Continue work** for execution. Reports and Mira's own actions do not trigger another assessment. A reviewed human approval of a task proposal is a human edit and may produce an assessment, but the assessment cannot create another proposal.

Each assessment automation has its own pause and notification policy. Results use the existing Reports and notification components. Ordinary task execution and automatic assessments share task admission, so they cannot run on the same task simultaneously.

## Steering ongoing work

Human edits and progress notes on an active task are coalesced and delivered through
Codex `turn/steer`, fenced to the exact provider turn and executor lease. Mira reads
the current saved requirements and progress, and adjusts the ongoing work. Successful
acknowledgements advance a durable edit cursor; a lost or mismatched acknowledgement
requires review rather than replay. An edit that arrives while the turn is ending
continues the same conversation once after the previous run completes.

Moving an active task to **Blocked** or **Done**, or assigning it to the operator,
prevents new tool calls immediately and requests interruption at the next lease check
(within five seconds). A tool already in progress cannot be undone; uncertain results
retain the existing review gate. Moving **Blocked → In progress** requests continued
work only if this owned task already has a user-started run in its linked conversation.
It never starts a new, previously unstarted task. A rapid unblock waits for the old
run to stop. Archived/deleted conversations, reassignment, completion, a newer explicit
Run or Stop, and unresolved outcomes prevent stale continuation. Global automatic-work
pause applies both when queuing and claiming continuations. An already queued
continuation stays pending until the pause is lifted. Requests not yet queued expire
after one day instead of replaying old board actions after a long outage.

Continuations retain the prior work budget and task permissions, but use the general
worker lane and automatic queue limits so direct user requests keep their reserved
worker and capacity. They preserve task admission and do not inherit expired
browser, computer, publication or spending permissions.
Updates consumed by active work do not create a second assessment report. Changes to
other tasks still use the individually controlled **Task created or changed** automation.

Continuation discovery advances a durable round-robin cursor after every bounded
batch, including batches deferred by a pause, full queue, uncertain result or busy
task. Blocked owners cannot monopolize later ticks. Deferred requests remain pending
and are revisited after other candidates, including after a scheduler restart.

Audit timestamps record the actual serialized write time. Completion takes the same
conversation/task locks before recording its terminal clock boundary, so edits from
older transactions cannot disappear between claim and completion.
