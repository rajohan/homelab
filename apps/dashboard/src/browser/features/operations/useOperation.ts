import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";

import { useIdentityClient } from "../../identity/IdentityClientContext";

/**
 * Run an explicit user action with shared step-up and invalidate operational read models.
 * @param operation - Typed API operation; retries are limited to explicit proof rejections.
 * @param onAccepted - Optional UI acknowledgement after the operation succeeds.
 * @returns Mutation state and controls without automatic network-error replay.
 */
export function useOperation<T, R>(
    operation: (input: T, signal: AbortSignal) => Promise<R>,
    onAccepted?: () => void
) {
    const identity = useIdentityClient();
    const queries = useQueryClient();
    return useMutation({
        mutationFn: (input: T) =>
            identity.verifiedOperation(
                (signal) => operation(input, signal),
                (error) =>
                    error instanceof TRPCClientError &&
                    error.message === "STEP_UP_REQUIRED"
            ),
        onSuccess: () => {
            // Show an accepted run immediately; unrelated read-model refreshes may be slow.
            void queries.invalidateQueries({ queryKey: ["operations"] });
            onAccepted?.();
        },
        retry: false,
    });
}
