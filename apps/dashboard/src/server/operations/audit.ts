import type { Transaction } from "../database/connection";

/**
 * Append safe operational metadata in the same transaction as its mutation.
 * @param transaction - The transaction owning the state change.
 * @param actor - The verified human, machine or worker identity.
 * @param action - A code-owned action name.
 * @param target - The affected record ID, never a payload or secret.
 * @param message - Optional validated, code-owned status text; never raw provider output.
 * @returns Completion after the audit row is admitted.
 */
export async function auditOperation(
    transaction: Transaction,
    actor: string,
    action: string,
    target: string,
    message: string | null = null
): Promise<void> {
    await transaction`INSERT INTO operation_audit (id, actor, action, target, message) VALUES (${Bun.randomUUIDv7()}, ${actor}, ${action}, ${target}, ${message})`;
}
