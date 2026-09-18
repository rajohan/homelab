import { useQuery, useQueryClient } from "@tanstack/react-query";

import { queryRefresh } from "../../../lib/queryRefresh";
import type { IdentityClient } from "../api/IdentityClient";

/**
 * Poll session identity and cancel pending actions and private caches when it changes.
 * @param client - The identity client shared by the account UI.
 * @returns The current session query, including pending and failure states.
 */
export function useIdentitySession(client: IdentityClient) {
    const queryClient = useQueryClient();
    return useQuery({
        queryKey: ["identity", "session"],
        queryFn: async () => {
            const result = await client.session();
            const previous = queryClient.getQueryData<
                Awaited<ReturnType<IdentityClient["session"]>>
            >(["identity", "session"]);
            if (
                (!result.authenticated &&
                    !result.mfaRequired &&
                    (previous?.authenticated || previous?.mfaRequired)) ||
                previous?.sessionId !== result.sessionId ||
                previous?.userId !== result.userId ||
                previous?.username !== result.username
            ) {
                client.cancelActions();
                queryClient.removeQueries({
                    predicate: (query) =>
                        !(
                            query.queryKey[0] === "identity" &&
                            query.queryKey[1] === "session"
                        ),
                });
            }
            return result;
        },
        retry: false,
        staleTime: 0,
        ...queryRefresh("normal"),
    });
}
