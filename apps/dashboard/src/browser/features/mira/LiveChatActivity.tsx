import type { MiraRun } from "@homelab/contracts/mira";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { ChatActivity } from "./ChatActivity";
import type { ChatDisplaySettings } from "./chatDisplay";

function useActivity(id: string, kind: "tools" | "notes", active: boolean) {
    const client = useQueryClient();
    const queryKey = ["operations", "mira", "activity", id, kind];
    const latest = useQuery({
        queryKey,
        queryFn: async ({ signal }) => {
            type Page = Awaited<ReturnType<typeof api.mira.activity.query>>;
            const previous = client.getQueryData<Page>(queryKey);
            const current = await api.mira.activity.query({ id, kind }, { signal });
            if (!previous?.rows.length) return current;
            const known = new Set(previous.rows.map((row) => row.id));
            const pages = [current];
            let page = current;
            while (page.nextCursor && !page.rows.some((row) => known.has(row.id))) {
                page = await api.mira.activity.query(
                    { id, kind, before: page.nextCursor },
                    { signal }
                );
                pages.unshift(page);
            }
            return {
                ...current,
                nextCursor: previous.nextCursor,
                rows: [
                    ...new Map(
                        [...previous.rows, ...pages.flatMap((entry) => entry.rows)].map(
                            (row) => [row.id, row]
                        )
                    ).values(),
                ],
            };
        },
        refetchInterval: active ? 1000 : 5000,
    });
    const history = useInfiniteQuery({
        queryKey: ["operations", "mira", "activity-history", id, kind],
        initialPageParam: undefined as string | undefined,
        enabled: false,
        queryFn: ({ pageParam, signal }) =>
            api.mira.activity.query(
                { id, kind, before: pageParam ?? latest.data?.nextCursor ?? undefined },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const rows = [
        ...new Map(
            [
                ...(history.data?.pages.toReversed().flatMap((page) => page.rows) ?? []),
                ...(latest.data?.rows ?? []),
            ].map((row) => [row.id, row])
        ).values(),
    ];
    return {
        rows,
        total: latest.data?.total ?? rows.length,
        continuation: {
            hasMore: history.data ? history.hasNextPage : !!latest.data?.nextCursor,
            loading: history.isFetching,
            error: history.error ?? latest.error ?? undefined,
            onLoadMore: () => {
                if (latest.isError) void latest.refetch();
                else if (history.isError) void history.refetch();
                else void history.fetchNextPage();
            },
        },
    };
}

/** Load newest activity separately from older pages so live polling stays bounded.
 * @returns Current tools and provider work notes using the shared chat presentation.
 */
export function LiveChatActivity({
    run,
    display,
}: {
    readonly run: MiraRun;
    readonly display: ChatDisplaySettings;
}) {
    const active = ["queued", "running"].includes(run.state);
    const tools = useActivity(run.id, "tools", active);
    const notes = useActivity(run.id, "notes", active);
    return (
        <ChatActivity
            run={run}
            tools={tools.rows}
            display={display}
            toolTotal={tools.total}
            toolContinuation={tools.continuation}
            notes={notes.rows}
            noteContinuation={notes.continuation}
        />
    );
}
