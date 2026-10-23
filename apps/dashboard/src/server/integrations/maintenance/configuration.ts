import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";

const targetSchema = v.strictObject({
    id: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,49}$/)),
    connection: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    impact: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    kind: v.picklist(["service", "host"]),
    service: v.optional(
        v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,150}\.service$/))
    ),
    health: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
        v.minLength(1),
        v.maxLength(30)
    ),
    workerIndependent: v.boolean(),
    externalReason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
    lockConnections: v.optional(v.pipe(v.array(v.string()), v.maxLength(10))),
    preflight: v.optional(
        v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(2000))),
            v.minLength(1),
            v.maxLength(30)
        )
    ),
});
export type MaintenanceTarget = v.InferOutput<typeof targetSchema>;

/**
 * Validate explicitly reviewed restart authority; no existing update target gains it implicitly.
 * @param value - Deployment-owned JSON, separate from software update consent.
 * @param connections - Existing scoped SSH targets and trust files.
 * @returns Restart recipes and explicitly external targets that remain visible without granting mutation authority.
 */
export function parseMaintenanceTargets(
    value: string | undefined,
    connections: readonly UpdateTarget[]
): MaintenanceTarget[] {
    const targets = v.parse(
        v.pipe(v.array(targetSchema), v.maxLength(100)),
        JSON.parse(value ?? "[]") as unknown
    );
    if (new Set(targets.map((target) => target.id)).size !== targets.length)
        throw new Error("Maintenance IDs must be unique");
    for (const target of targets) {
        if (
            !connections.some((connection) => connection.id === target.connection) ||
            (target.kind === "service") !== Boolean(target.service) ||
            !target.health[0]?.startsWith("/") ||
            target.health.some((argument) => argument.includes("\0")) ||
            (!target.workerIndependent && !target.externalReason) ||
            (target.workerIndependent && Boolean(target.externalReason)) ||
            (target.lockConnections ?? []).some(
                (id) => !connections.some((connection) => connection.id === id)
            ) ||
            (target.preflight &&
                (!target.preflight[0]?.startsWith("/") ||
                    target.preflight.some((argument) => argument.includes("\0"))))
        )
            throw new Error(
                "Maintenance requires an existing connection and a fixed health command"
            );
    }
    return targets;
}

/**
 * Bind restart consent to the exact deployment recipe and its SSH authority.
 * @param target - Validated restart recipe.
 * @param connection - Its existing update connection.
 * @returns A stable digest that changes when either authority changes.
 */
export function maintenanceRevision(
    target: MaintenanceTarget,
    connection: UpdateTarget
): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify({ target, connection }))
        .digest("hex");
}
