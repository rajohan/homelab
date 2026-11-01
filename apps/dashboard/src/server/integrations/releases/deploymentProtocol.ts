import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";
import { updateSshArguments } from "../updates/execution";
import type { ReleaseDeploymentHostTarget } from "./deploymentConfiguration";
import program from "./deploymentHost.py" with { type: "text" };

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const imageId = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
const containerSchema = v.strictObject({
    dashboardSchema: v.optional(v.nullable(hash)),
    authSchema: v.optional(v.nullable(hash)),
    id: hash,
    name: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/))),
    imageId,
    image: v.pipe(v.string(), v.maxLength(500)),
    running: v.boolean(),
    health: v.nullable(v.picklist(["healthy", "unhealthy", "starting"])),
});
export const deploymentObservationSchema = v.strictObject({
    targetHash: hash,
    composeHash: hash,
    configHash: hash,
    browserHash: v.nullable(hash),
    containers: v.record(v.string(), containerSchema),
    units: v.record(
        v.string(),
        v.strictObject({
            active: v.literal("active"),
            invocation: v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/)),
        })
    ),
});
export const deploymentReleaseSchema = v.strictObject({
    dashboardSchema: v.optional(hash),
    authSchema: v.optional(hash),
    repository: v.pipe(
        v.string(),
        v.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
    ),
    version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/)),
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    images: v.pipe(
        v.array(
            v.strictObject({
                app: v.picklist([
                    "auth",
                    "dashboard",
                    "mira",
                    "mira-browser",
                    "mira-browser-proxy",
                ]),
                reference: v.pipe(v.string(), v.maxLength(500)),
            })
        ),
        v.minLength(2),
        v.maxLength(5)
    ),
});
export const deploymentPlanSchema = v.strictObject({
    configuration: hash,
    release: deploymentReleaseSchema,
    expected: deploymentObservationSchema,
    authExpected: v.optional(deploymentObservationSchema),
});
const id = v.pipe(v.string(), v.uuid());
export const deploymentReceiptSchema = v.variant("state", [
    v.strictObject({ state: v.literal("absent"), id }),
    v.object({
        state: v.picklist(["running", "succeeded", "failed", "unknown"]),
        id,
        requestHash: hash,
        phase: v.picklist([
            "accepted",
            "checking",
            "pulling",
            "stopping",
            "backup",
            "configuring",
            "migrating",
            "starting",
            "verifying",
            "complete",
            "failed",
        ]),
        updatedAt: v.number(),
        changesStarted: v.boolean(),
        migrationStarted: v.boolean(),
        code: v.optional(v.pipe(v.string(), v.regex(/^[a-z_]{1,64}$/))),
        recovered: v.optional(v.boolean()),
        version: v.optional(deploymentReleaseSchema.entries.version),
        revision: v.optional(deploymentReleaseSchema.entries.revision),
        containers: v.optional(v.record(v.string(), containerSchema)),
    }),
]);
export type DeploymentPlan = v.InferOutput<typeof deploymentPlanSchema>;
export type DeploymentRelease = DeploymentPlan["release"];
export type DeploymentObservation = DeploymentPlan["expected"];
export type DeploymentReceipt = v.InferOutput<typeof deploymentReceiptSchema>;
export const deploymentProgressSchema = v.strictObject({
    stage: v.picklist(["auth", "main"]),
    submitted: v.boolean(),
    authAlreadyCurrent: v.optional(v.literal(true)),
    auth: v.optional(deploymentReceiptSchema),
    main: v.optional(deploymentReceiptSchema),
});
export type DeploymentProgress = v.InferOutput<typeof deploymentProgressSchema>;
export type DeploymentHostRequest = { target: ReleaseDeploymentHostTarget } & (
    | { mode: "inspect"; release: DeploymentRelease; allowCurrent?: boolean }
    | { mode: "status"; id: string }
    | {
          mode: "submit";
          id: string;
          release: DeploymentRelease;
          expected: DeploymentObservation;
          deadline: number;
      }
);
export type DeploymentHost = (
    connection: UpdateTarget,
    request: DeploymentHostRequest,
    signal: AbortSignal
) => Promise<unknown>;

/**
 * Hash JSON identically to the host journal, independent of object insertion order.
 * @param value - Serializable nonsecret operation evidence.
 * @returns SHA-256 over sorted, compact JSON.
 */
export function deploymentDigest(value: unknown): string {
    const sort = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map((child) => sort(child));
        if (item !== null && typeof item === "object")
            return Object.fromEntries(
                Object.entries(item)
                    .toSorted(([a], [b]) => {
                        if (a < b) return -1;
                        return a > b ? 1 : 0;
                    })
                    .map(([key, child]) => [key, sort(child)])
            );
        return item;
    };
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(sort(value)))
        .digest("hex");
}

/**
 * Invoke the fixed host protocol over existing pinned SSH trust and bound its receipt.
 * @param connection - Operator-owned SSH authority.
 * @param request - Validated private target and frozen operation evidence.
 * @param signal - Short coordinator or preparation lifetime, independent of host execution.
 * @returns A JSON receipt; callers validate the expected operation-specific schema.
 */
export const deploymentHost: DeploymentHost = async (connection, request, signal) => {
    const source = `SOURCE = ${JSON.stringify(program)}\nexec(compile(SOURCE, '<homelab-release>', 'exec'))`;
    const child = Bun.spawn(updateSshArguments(connection, source), {
        stdin: new TextEncoder().encode(JSON.stringify(request)),
        stdout: "pipe",
        stderr: "ignore",
        signal,
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
    });
    try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of child.stdout) {
            size += chunk.byteLength;
            if (size > 65_536) throw new Error("Deployment receipt exceeded its limit");
            chunks.push(chunk);
        }
        if ((await child.exited) !== 0)
            throw new Error("Deployment host operation failed");
        const result = v.parse(
            v.strictObject({ ok: v.literal(true), result: v.unknown() }),
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
        );
        return result.result;
    } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
    }
};
