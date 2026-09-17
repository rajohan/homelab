import type { WorkerControl } from "@homelab/contracts/operations";
import type { SQL } from "bun";

import { auditOperation } from "../operations/audit";
import { OperationFailure } from "../operations/errors";
import { lockQueue } from "./queue";

/**
 * Read the durable control state shared by every worker instance.
 * @param client - Dashboard database connection.
 * @returns A versioned pause state; an uninitialized database is accepting work.
 */
export async function readWorkerControl(client: SQL): Promise<WorkerControl> {
    const [control] = await client<
        WorkerControl[]
    >`SELECT paused, version, updated_at::text AS "updatedAt", updated_by AS "updatedBy" FROM worker_control WHERE id = 1`;
    return control ?? { paused: false, version: 1, updatedAt: null, updatedBy: null };
}

/**
 * Pause or resume new claims atomically with queue admission and an audit record.
 * @param client - Dashboard database connection.
 * @param actor - Verified operator or machine identity.
 * @param input - Optimistically versioned desired pause state.
 * @returns Completion after persistence; active work is deliberately left untouched.
 */
export async function setWorkerControl(
    client: SQL,
    actor: string,
    input: { version: number; paused: boolean }
): Promise<void> {
    await client.begin(async (transaction) => {
        await lockQueue(transaction);
        await transaction`INSERT INTO worker_control (id) VALUES (1) ON CONFLICT DO NOTHING`;
        const changed = await transaction<
            { id: number }[]
        >`UPDATE worker_control SET paused = ${input.paused}, version = version + 1, updated_at = now(), updated_by = ${actor} WHERE id = 1 AND version = ${input.version} RETURNING id`;
        if (!changed[0])
            throw new OperationFailure(
                "CONFLICT",
                "Worker control changed. Refresh before trying again."
            );
        await auditOperation(
            transaction,
            actor,
            input.paused ? "worker.paused" : "worker.resumed",
            "worker"
        );
    });
}
