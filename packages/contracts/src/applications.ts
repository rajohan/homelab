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
    }[];
    readonly networks: readonly string[];
}
export interface ApplicationInventory {
    readonly capturedAt: string;
    readonly hosts: readonly {
        id: string;
        label: string;
        available: boolean;
        applications: readonly ManagedApplication[];
    }[];
}
