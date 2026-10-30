import type { miraBrowserHumanCommandSchema } from "@homelab/contracts/miraBrowser";
import { useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { useEffect, useRef, useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";
import { useIdentityClient } from "../../identity/IdentityClientContext";

/**
 * Send private operator input without retaining its variables in the mutation cache.
 * @returns Pending/error state and an explicit one-shot sender; network errors are never replayed.
 */
export function useBrowserCommand() {
    const identity = useIdentityClient();
    const queries = useQueryClient();
    const pending = useRef(false);
    const lifetime = useRef<AbortController | null>(null);
    const [isPending, setPending] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    useEffect(
        () => () => {
            lifetime.current?.abort();
        },
        []
    );
    const mutate = (input: v.InferOutput<typeof miraBrowserHumanCommandSchema>) => {
        if (pending.current) return;
        pending.current = true;
        setPending(true);
        setError(null);
        const controller = new AbortController();
        lifetime.current = controller;
        void identity
            .verifiedOperation(
                (signal) =>
                    api.mira.browser.command.mutate(input, {
                        signal: AbortSignal.any([signal, controller.signal]),
                    }),
                (value) =>
                    value instanceof TRPCClientError &&
                    value.message === "STEP_UP_REQUIRED"
            )
            .then(
                () => {
                    void queries.invalidateQueries({
                        queryKey: ["operations", "mira", "browser-console", input.id],
                    });
                    return null;
                },
                () => {
                    setError(
                        new Error(
                            "The command could not be confirmed. Refresh the browser status before continuing; do not repeat the input."
                        )
                    );
                    void queries.invalidateQueries({
                        queryKey: ["operations", "mira", "browser-console", input.id],
                    });
                }
            )
            .finally(() => {
                pending.current = false;
                setPending(false);
                lifetime.current = null;
            });
    };
    return { mutate, isPending, error };
}
