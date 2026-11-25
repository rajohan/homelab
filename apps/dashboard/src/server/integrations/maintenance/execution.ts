import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";
import { updateSshArguments } from "../updates/execution";
import type { MaintenanceTarget } from "./configuration";
import program from "./remote.py" with { type: "text" };
import serviceReport from "./service_report.py" with { type: "text" };

const invocationSchema = v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/)));
const unitSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
const reportedUnitSchema = v.strictObject({
    unit: unitSchema,
    aliases: v.optional(v.pipe(v.array(unitSchema), v.maxLength(64))),
    invocationId: invocationSchema,
    restartable: v.boolean(),
});

export const fleetReportSchema = v.strictObject({
    evidence: v.picklist(["measured", "not-installed", "check-failed"]),
    services: v.pipe(v.array(reportedUnitSchema), v.maxLength(1024)),
});

export const observationSchema = v.strictObject({
    fleet: v.optional(fleetReportSchema),
    canonicalUnit: v.optional(unitSchema),
    serviceEvidence: v.optional(
        v.nullable(v.picklist(["stopped", "not-installed", "check-failed", "measured"]))
    ),
    bootId: v.pipe(v.string(), v.uuid()),
    active: v.nullable(v.picklist(["active", "inactive"])),
    invocationId: invocationSchema,
    rebootRequired: v.nullable(v.boolean()),
    serviceRestartRequired: v.nullable(v.boolean()),
    health: v.boolean(),
});
export type MaintenanceObservation = v.InferOutput<typeof observationSchema>;
export type MaintenanceProbe = (
    connection: UpdateTarget,
    target: MaintenanceTarget,
    mode: "inspect" | "state" | "restart" | "verify" | "preflight",
    signal: AbortSignal,
    expected?: MaintenanceObservation,
    requiredOnly?: boolean
) => Promise<MaintenanceObservation>;

/**
 * Run a fixed maintenance operation over existing pinned SSH trust without returning host output.
 * @param connection - Server-owned SSH connection.
 * @param target - Reviewed restart recipe, never browser command arguments.
 * @param mode - Read-only inspection/verification or a single confirmed mutation.
 * @param signal - Job ownership and deadline.
 * @param expected - Boot/service identity captured by the approved plan.
 * @param requiredOnly - Recheck the pending requirement immediately before mutation.
 * @returns A bounded, validated observation; command failures remain unverified outcomes.
 */
export const probeMaintenance: MaintenanceProbe = async (
    connection,
    target,
    mode,
    signal,
    expected,
    requiredOnly = false
) => {
    signal.throwIfAborted();
    const child = Bun.spawn(
        updateSshArguments(connection, serviceReport + "\n" + program),
        {
            stdin: new TextEncoder().encode(
                JSON.stringify({ target, mode, expected, requiredOnly })
            ),
            stdout: "pipe",
            stderr: "ignore",
            signal,
            env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
        }
    );
    try {
        let result = "";
        for await (const chunk of child.stdout) {
            if (result.length + chunk.length > 512 * 1024)
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
