import * as v from "valibot";

const text = (length: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(length));

/** Operator-facing progress for a restart verified by an independent Proxmox controller. */
export const controllerRestartMessages = {
    waiting: "Waiting for active work to finish.",
    submitted: "Proxmox is verifying the restart.",
    verified: "Recovery verified by Proxmox.",
    refused: "Restart was not started.",
    unverified: "Recovery could not be verified. Inspect the target before retrying.",
} as const;

/** A verified, code-owned maintenance result; no command output or credentials. */
export const maintenanceResultSchema = v.strictObject({
    label: text(255),
    operation: v.picklist([
        "update",
        "service-restart",
        "host-restart",
        "restart-not-started",
    ]),
    installed: v.nullable(text(300)),
    health: v.picklist(["passed", "not-checked", "preserved-stopped"]),
    rebootRequired: v.nullable(v.boolean()),
    warnings: v.pipe(v.array(text(500)), v.maxLength(10)),
});
export type MaintenanceResult = v.InferOutput<typeof maintenanceResultSchema>;
export const maintenanceResultsSchema = v.pipe(
    v.array(maintenanceResultSchema),
    v.maxLength(400)
);

export const maintenanceRequestSchema = v.strictObject({
    target: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/)),
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    requestId: v.pipe(v.string(), v.uuid()),
});

export const maintenanceBatchRequestSchema = v.strictObject({
    requestId: maintenanceRequestSchema.entries.requestId,
    targets: v.pipe(
        v.array(v.omit(maintenanceRequestSchema, ["requestId"])),
        v.minLength(1),
        v.maxLength(8192)
    ),
});
