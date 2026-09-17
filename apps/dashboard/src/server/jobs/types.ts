import type { Capability, ResourceClass } from "@homelab/contracts/operations";
import type { TransactionSQL } from "bun";

export interface JobDefinition {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly resourceClass: ResourceClass;
    readonly capability: Capability;
    readonly resourceKeys: readonly string[];
    readonly timeoutMs: number;
    readonly attemptLimit: number;
    readonly retrySafe: boolean;
    readonly intervalSeconds: number | null;
    readonly validate: (input: unknown) => Record<string, unknown>;
}
export interface JobExecution {
    readonly signal: AbortSignal;
    readonly runId: string;
    readonly leaseToken: string;
    /** Persist a result only while the job still owns its live claim. */
    readonly commit: (
        write: (transaction: TransactionSQL) => Promise<void>
    ) => Promise<boolean>;
}
export interface JobHandler {
    readonly definition: JobDefinition;
    readonly execute: (
        payload: Record<string, unknown>,
        context: JobExecution
    ) => Promise<void>;
}
export interface ClaimedJob {
    readonly id: string;
    readonly action: string;
    readonly payload: Record<string, unknown>;
    readonly attempt: number;
    readonly attempt_limit: number;
    readonly retry_safe: boolean;
    readonly timeout_ms: number;
    readonly resource_keys: string[];
    readonly lease_token: string;
}
