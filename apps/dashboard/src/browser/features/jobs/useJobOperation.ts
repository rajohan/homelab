import { useContext } from "react";

import { useOperation } from "../operations/useOperation";
import { JobActivityContext } from "./JobActivityContext";

/**
 * Submit a manually requested job and reveal its activity only after server acceptance.
 * @param operation - Idempotent queue admission; an error never opens the activity panel.
 * @returns The shared verified mutation with no automatic retry or modal navigation.
 */
export function useJobOperation<T>(
    operation: (input: T, signal: AbortSignal) => Promise<{ id: string }>
) {
    const reveal = useContext(JobActivityContext);
    return useOperation(operation, reveal);
}
