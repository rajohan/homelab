import { capabilities, resourceClasses } from "@homelab/contracts/operations";

import type { JobDefinition, JobHandler } from "./types";

/**
 * Validate and index a code-owned job inventory without granting runtime shell access.
 * @param handlers - Explicitly composed integrations and maintenance actions.
 * @returns Unique action definitions and their worker-only executors.
 */
export function createJobRegistry(handlers: readonly JobHandler[]) {
    const registry = new Map<string, JobHandler>();
    for (const handler of handlers) {
        const definition = handler.definition;
        if (
            !/^[a-z][a-z0-9.-]{0,79}$/.test(definition.key) ||
            registry.has(definition.key) ||
            !definition.label.trim() ||
            !definition.description.trim() ||
            !resourceClasses.includes(definition.resourceClass) ||
            !capabilities.includes(definition.capability) ||
            !Number.isInteger(definition.timeoutMs) ||
            definition.timeoutMs < 1000 ||
            definition.timeoutMs > 3_600_000 ||
            !Number.isInteger(definition.attemptLimit) ||
            definition.attemptLimit < 1 ||
            definition.attemptLimit > 10 ||
            (!definition.retrySafe && definition.attemptLimit !== 1) ||
            definition.resourceKeys.some((key) => !/^[a-z0-9:._-]{1,120}$/.test(key)) ||
            new Set(definition.resourceKeys).size !== definition.resourceKeys.length ||
            (definition.intervalSeconds !== null &&
                (!Number.isInteger(definition.intervalSeconds) ||
                    definition.intervalSeconds < 60 ||
                    definition.intervalSeconds > 2_592_000))
        )
            throw new Error("Invalid job registration");
        registry.set(definition.key, handler);
    }
    return registry as ReadonlyMap<string, JobHandler>;
}

/**
 * Derive a stable identity for a code-owned job payload and execution policy.
 * @param definition - The registered policy captured when queuing the job.
 * @param payload - Validated action data.
 * @returns A digest used to reject conflicting idempotent submissions.
 */
export function jobFingerprint(
    definition: JobDefinition,
    payload: Record<string, unknown>
): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify({ definition, payload }))
        .digest("hex");
}
