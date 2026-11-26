import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";
import { updateSshArguments } from "../updates/execution";
import type { MaintenanceTarget } from "./configuration";
import program from "./remote.py" with { type: "text" };
import serviceReport from "./service_report.py" with { type: "text" };
import systemBus from "./system_bus.py" with { type: "text" };
import ubuntuBus from "./ubuntu_bus.py" with { type: "text" };

const busProgram = serviceReport + "\n" + ubuntuBus + "\n" + systemBus;

export const busRecoveryMessages = {
    qualified: null,
    network:
        "The host could not verify its default gateway or an uncached dashboard DNS lookup.",
    workloads:
        "The host could not confirm its Docker workload or package maintenance prerequisites.",
    implementation:
        "This system bus implementation has no qualified online restart recipe.",
    "unit-policy":
        "Restarting the bus would affect other systemd units or violate their restart policy.",
    clients:
        "Other connected clients need a recovery plan before the system bus can restart.",
    login: "The login manager's bus ownership and session interface could not be confirmed.",
    inhibitors:
        "The login manager has active system inhibitors. Wait for their owners to release them.",
    sessions: "Other login sessions are active. Wait until the host is unattended.",
    unavailable:
        "The system-bus recovery preflight could not be verified. Refresh the host or schedule manual maintenance.",
} as const;
const busRecoverySchema = v.picklist(
    Object.keys(busRecoveryMessages) as (keyof typeof busRecoveryMessages)[]
);

/** The remote check explicitly refused before sending a restart. */
export class MaintenanceRefused extends Error {}

const refusalMessages = {
    ...busRecoveryMessages,
    authority: "This service requires a different restart method.",
    identity: "The host or service identity changed before the restart.",
    requirement: "Linux no longer reports this instance as needing a restart.",
    preflight: "The host's restart prerequisites could not be verified.",
    prerequisites: "The service does not meet its restart prerequisites.",
} as const;
const refusalSchema = v.strictObject({
    restart: v.literal("not-started"),
    reason: v.picklist(Object.keys(refusalMessages) as (keyof typeof refusalMessages)[]),
});

const invocationSchema = v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/)));
const unitSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
const reportedUnitSchema = v.strictObject({
    unit: unitSchema,
    aliases: v.optional(v.pipe(v.array(unitSchema), v.maxLength(64))),
    invocationId: invocationSchema,
    restartable: v.boolean(),
    busRecovery: v.optional(busRecoverySchema),
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
    requiredOnly?: boolean,
    operationId?: string
) => Promise<MaintenanceObservation>;

/**
 * Run a fixed maintenance operation over existing pinned SSH trust without returning host output.
 * @param connection - Server-owned SSH connection.
 * @param target - Reviewed restart recipe, never browser command arguments.
 * @param mode - Read-only inspection/verification or a single confirmed mutation.
 * @param signal - Job ownership and deadline.
 * @param expected - Boot/service identity captured by the approved plan.
 * @param requiredOnly - Recheck the pending requirement immediately before mutation.
 * @param operationId - Stable queue identity for an independent D-Bus recovery receipt.
 * @returns A bounded, validated observation; command failures remain unverified outcomes.
 */
export const probeMaintenance: MaintenanceProbe = async (
    connection,
    target,
    mode,
    signal,
    expected,
    requiredOnly = false,
    operationId
) => {
    signal.throwIfAborted();
    const child = Bun.spawn(updateSshArguments(connection, busProgram + "\n" + program), {
        stdin: new TextEncoder().encode(
            JSON.stringify({
                target,
                mode,
                expected,
                requiredOnly,
                operationId,
                ...(mode === "restart" && target.service === "dbus.service"
                    ? { busProgram }
                    : {}),
            })
        ),
        stdout: "pipe",
        stderr: "ignore",
        signal,
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
    });
    try {
        let result = "";
        for await (const chunk of child.stdout) {
            if (result.length + chunk.length > 512 * 1024)
                throw new Error("Maintenance response exceeded its budget");
            result += new TextDecoder().decode(chunk);
        }
        const status = await child.exited;
        if (status === 3 && result.length <= 200 && result.trimStart().startsWith("{")) {
            const outcome = v.safeParse(refusalSchema, JSON.parse(result) as unknown);
            if (outcome.success && outcome.output.reason !== "qualified")
                throw new MaintenanceRefused(refusalMessages[outcome.output.reason]);
        }
        if (status !== 0) throw new Error("Maintenance outcome could not be verified");
        return v.parse(observationSchema, JSON.parse(result) as unknown);
    } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
    }
};
