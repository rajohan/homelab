import type { ResourceClass } from "@homelab/contracts/operations";
import type { SQL, TransactionSQL } from "bun";

/** Work classes allowed in the reserved lane, regardless of who requested the job. */
export const controlWorkClasses: readonly ResourceClass[] = ["light", "network"];

/** Longer inventory scans belong in general slots even when they only perform network reads. */
export const controlWorkTimeoutMs = 60_000;

/**
 * Identify jobs that fit the control reservation in either a queue or running-job query.
 * @param query - SQL connection or claim transaction with job_runs in scope.
 * @returns SQL eligibility predicate for the current row.
 */
export function fitsControlSlot(query: SQL | TransactionSQL) {
    return query`(resource_class = ANY(${query.array([...controlWorkClasses], "TEXT")}) AND timeout_ms <= ${controlWorkTimeoutMs})`;
}

/**
 * Reserve one of the existing slots without making a one-slot worker unusable.
 * @param capacity - Validated total worker concurrency.
 * @returns Slots reserved for light and network control work.
 */
export function reservedCapacity(capacity: number): number {
    return capacity > 1 ? 1 : 0;
}
