# Mira task execution

Tasks keep their requirements and human-managed status separately from each run.
Moving a card does not start work, and a finished run does not automatically mark
the task complete.

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
have only one queued or running execution. Completed or operator-assigned tasks
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
