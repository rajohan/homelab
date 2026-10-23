import type { SQL, TransactionSQL } from "bun";

/**
 * Read the shared database clock before collecting or publishing restart evidence.
 * @param client - Dashboard connection or the transaction recording a verified receipt.
 * @returns An observation timestamp independent of dashboard and worker clock skew.
 */
export async function restartObservationTime(
    client: SQL | TransactionSQL
): Promise<string> {
    const [clock] = await client<
        { observedAt: Date }[]
    >`SELECT clock_timestamp() AS "observedAt"`;
    if (!clock) throw new Error("Restart observation clock unavailable");
    return clock.observedAt.toISOString();
}

/**
 * Persist a restart observation without allowing a delayed probe to replace a newer result.
 * @param client - Dashboard connection or the transaction recording an update receipt.
 * @param source - Server-authorized update source identity.
 * @param required - Observed flag, or null when it could not be determined.
 * @param observedAt - Time the observation began, not the time its response arrived.
 * @returns Completion after the monotonic snapshot write.
 */
export async function recordRestartObservation(
    client: SQL | TransactionSQL,
    source: string,
    required: boolean | null,
    observedAt: string
): Promise<void> {
    await client`INSERT INTO operation_snapshots (key, value, captured_at)
        VALUES (${`updates.restart:${source}`}, ${JSON.stringify({ required, observedAt })}::text::jsonb, ${new Date(observedAt)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at
        WHERE operation_snapshots.captured_at < EXCLUDED.captured_at`;
}
