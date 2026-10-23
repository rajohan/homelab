import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";
import { updateSshArguments } from "../updates/execution";
import type { MaintenanceTarget } from "./configuration";
import program from "./remote.py" with { type: "text" };

export const observationSchema = v.strictObject({
    bootId: v.pipe(v.string(), v.uuid()),
    active: v.nullable(v.picklist(["active", "inactive"])),
    rebootRequired: v.boolean(),
    serviceRestartRequired: v.nullable(v.boolean()),
    health: v.boolean(),
});
export type MaintenanceObservation = v.InferOutput<typeof observationSchema>;
export type MaintenanceProbe = (
    connection: UpdateTarget,
    target: MaintenanceTarget,
    mode: "inspect" | "restart" | "verify",
    signal: AbortSignal,
    expected?: MaintenanceObservation
) => Promise<MaintenanceObservation>;

/**
 * Run a fixed maintenance operation over existing pinned SSH trust without returning host output.
 * @param connection - Server-owned SSH connection.
 * @param target - Reviewed restart recipe, never browser command arguments.
 * @param mode - Read-only inspection/verification or a single confirmed mutation.
 * @param signal - Job ownership and deadline.
 * @param expected - Boot/service identity captured by the approved plan.
 * @returns A bounded, validated observation; command failures remain unverified outcomes.
 */
export const probeMaintenance: MaintenanceProbe = async (
    connection,
    target,
    mode,
    signal,
    expected
) => {
    signal.throwIfAborted();
    const child = Bun.spawn(updateSshArguments(connection, program), {
        stdin: new TextEncoder().encode(JSON.stringify({ target, mode, expected })),
        stdout: "pipe",
        stderr: "ignore",
        signal,
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
    });
    try {
        let result = "";
        for await (const chunk of child.stdout) {
            if (result.length + chunk.length > 4096)
                throw new Error("Maintenance response exceeded its budget");
            result += new TextDecoder().decode(chunk);
        }
        if ((await child.exited) !== 0)
            throw new Error("Maintenance outcome could not be verified");
        return v.parse(observationSchema, JSON.parse(result) as unknown);
    } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
    }
};
