import type { MiraTask, MiraTaskBoardCursor } from "@homelab/contracts/mira";
import { useInfiniteQuery } from "@tanstack/react-query";

import { api } from "../../api/client";

/** Load an independently paged column for the selected board filters.
 * @param status - Board column to read.
 * @param search - Task or label search text.
 * @param assignee - Selected task owner.
 * @returns The query used by the column and its parent board.
 */
export function useTaskColumn(
    status: MiraTask["status"],
    search: string,
    assignee: MiraTask["assignee"] | "all"
) {
    return useInfiniteQuery({
        queryKey: ["operations", "mira", "tasks", status, search, assignee],
        initialPageParam: undefined as MiraTaskBoardCursor | string | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.mira.tasks.list.query(
                {
                    search,
                    archived: false,
                    status,
                    ...(assignee === "all" ? {} : { assignee }),
                    ...(pageParam ? { before: pageParam } : {}),
                },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 15_000,
    });
}
