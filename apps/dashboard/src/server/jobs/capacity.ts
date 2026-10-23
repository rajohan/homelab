import type { ResourceClass } from "@homelab/contracts/operations";

/** Work classes allowed in the reserved lane, regardless of who requested the job. */
export const controlWorkClasses: readonly ResourceClass[] = ["light", "network"];

/**
 * Reserve one of the existing slots without making a one-slot worker unusable.
 * @param capacity - Validated total worker concurrency.
 * @returns Slots reserved for light and network control work.
 */
export function reservedCapacity(capacity: number): number {
    return capacity > 1 ? 1 : 0;
}
