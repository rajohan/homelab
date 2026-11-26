import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";

/** Share the executor's current model choices between chat and automation settings.
 * @returns The live catalog, provider quota and freshness of the last observation.
 */
export function useChatModels() {
    return useQuery({
        queryKey: ["operations", "mira", "models"],
        queryFn: ({ signal }) => api.mira.models.query(undefined, { signal }),
        refetchInterval: 30_000,
    });
}
