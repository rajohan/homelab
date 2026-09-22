import * as v from "valibot";

import { idSchema } from "./operations";

export const applicationOperationSchema = v.picklist(["start", "stop", "restart"]);
export const applicationHostSchema = v.pipe(
    v.string(),
    v.regex(/^[a-z][a-z0-9-]{0,31}$/)
);
export const applicationTargetSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("container"),
        target: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    }),
    v.strictObject({
        kind: v.literal("project"),
        target: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._-]{0,79}$/)),
    }),
]);
export const applicationIntentSchema = v.strictObject({
    host: applicationHostSchema,
    selection: applicationTargetSchema,
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    operation: applicationOperationSchema,
    requestId: idSchema,
});
export type ApplicationOperation = v.InferOutput<typeof applicationOperationSchema>;

/**
 * Select meaningful lifecycle actions from observed container states.
 * @param states - All states in the selected container or Compose project.
 * @returns Actions in display order; mixed projects can start stopped members or stop running ones.
 */
export function availableApplicationOperations(
    states: readonly string[]
): readonly ApplicationOperation[] {
    const operations: ApplicationOperation[] = [];
    if (states.some((state) => ["created", "exited"].includes(state)))
        operations.push("start");
    if (states.some((state) => ["running", "restarting"].includes(state)))
        operations.push("restart");
    if (states.some((state) => ["running", "restarting", "paused"].includes(state)))
        operations.push("stop");
    return operations;
}
export type ApplicationSelection = v.InferOutput<typeof applicationTargetSchema>;
export type ApplicationIntent = v.InferOutput<typeof applicationIntentSchema>;

export interface ManagedApplication {
    readonly id: string;
    readonly host: string;
    readonly containerId: string;
    readonly name: string;
    readonly containerName: string;
    readonly project: string;
    readonly image: string;
    readonly imageId: string;
    readonly state: string;
    readonly health: string | null;
    readonly startedAt: string;
    readonly revision: string;
    /** Exact namespace providers; absent only in older snapshots. */
    readonly namespaceParents?: readonly string[];
    /** Revision and names of the complete, server-computed lifecycle impact. */
    readonly actionRevision?: string;
    readonly relatedApplications?: readonly string[];
    readonly ports: readonly {
        container: string;
        hostAddress: string;
        hostPort: string;
    }[];
    readonly mounts: readonly {
        type: string;
        source: string;
        destination: string;
        readOnly: boolean;
        /** Whether the runtime invokes code from this mount; arguments are never exposed. */
        startupCode?: boolean;
    }[];
    readonly networks: readonly string[];
}
export interface ApplicationInventory {
    readonly capturedAt: string;
    readonly hosts: readonly {
        id: string;
        label: string;
        available: boolean;
        /** Start of this host's Docker reads; older snapshots cannot reconcile software reports. */
        observationStartedAt?: string;
        applications: readonly ManagedApplication[];
    }[];
}
