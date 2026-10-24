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
before requesting continued work. Acceptance is recorded on the new run and never
rewrites unknown tool receipts or silently replays prior actions. A reviewed
outcome does not ask for the same confirmation on every later continuation; a new
uncertain run requires its own review.

## Qualification

Integration tests cover account isolation, concurrent/idempotent starts, run and
task status separation, manual-versus-automatic admission, conversation recovery,
uncertain receipts and task deletion. Component coverage verifies that an uncertain
submission preserves its request identity and input. The desktop/mobile preview
uses synthetic responses and has no production or provider connection.
