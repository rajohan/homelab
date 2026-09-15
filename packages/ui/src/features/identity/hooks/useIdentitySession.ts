import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { IdentityClient } from "../api/IdentityClient";

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
        refetchOnWindowFocus: true,
        refetchInterval: 60_000,
    });
}
