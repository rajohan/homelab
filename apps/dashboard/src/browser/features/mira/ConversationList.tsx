import type { MiraConversationCursor } from "@homelab/contracts/mira";
import {
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    SearchInput,
    SectionHeader,
    Switch,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { NewConversationButton } from "./NewConversationButton";

/**
 * Browse searchable conversations with explicit archive filtering and bounded pages.
 * @returns The conversation sidebar, stacked above chat on smaller screens.
 */
export function ConversationList({
    selected,
    onSelect,
    embedded = false,
}: {
    readonly embedded?: boolean;
    readonly onSelect?: () => void;
    readonly selected?: string | undefined;
}) {
    const [search, setSearch] = useState("");
    const [archived, setArchived] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const filter = JSON.stringify([search, archived]);
    const latest = useQuery({
        queryKey: ["operations", "mira", "conversations", search, archived, "latest"],
        queryFn: ({ signal }) =>
            api.mira.conversations.list.query({ search, archived }, { signal }),
        ...queryRefresh("fast"),
    });
    const history = useInfiniteQuery({
        queryKey: [
            "operations",
            "mira",
            "conversations",
            search,
            archived,
            "history",
            latest.data?.nextCursor,
        ],
        initialPageParam: latest.data?.nextCursor as MiraConversationCursor | undefined,
        enabled: expanded === filter && !!latest.data?.nextCursor,
        queryFn: ({ pageParam, signal }) =>
            api.mira.conversations.list.query(
                { search, archived, ...(pageParam ? { before: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
    const rows = [
        ...(latest.data?.rows ?? []),
        ...(history.data?.pages.flatMap((page) => page.rows) ?? []),
    ];
    const byId = new Map<string, (typeof rows)[number]>();
    for (const chat of rows) if (!byId.has(chat.id)) byId.set(chat.id, chat);
    const conversations = [...byId.values()];
    const hasMore = history.data ? history.hasNextPage : !!latest.data?.nextCursor;
    return (
        <Card
            className={`flex min-h-0 w-full flex-col gap-4 p-4 sm:p-4 ${embedded ? "border-0 bg-transparent p-0 shadow-none sm:p-0" : ""}`}
        >
            <SectionHeader title="Conversations" icon={MessageSquare} />
            <NewConversationButton fullWidth onSelect={onSelect} />
            <SearchInput
                label="Search conversations"
                value={search}
                onChange={setSearch}
                placeholder="Search messages…"
            />
            <Switch
                label="Archived conversations"
                checked={archived}
                onChange={setArchived}
            />
            {latest.isPending && <LoadingState label="Loading conversations…" />}
            {(latest.error || history.error) && (
                <ErrorNotice error={latest.error ?? history.error} />
            )}
            <nav
                aria-label="Conversations"
                className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-0.5"
            >
                {conversations.map((chat) => (
                    <Link
                        key={chat.id}
                        to="/mira/$conversationId"
                        params={{ conversationId: chat.id }}
                        onClick={onSelect}
                        aria-current={selected === chat.id ? "page" : undefined}
                        className={`block rounded-lg border px-3 py-2.5 text-sm wrap-anywhere transition ${selected === chat.id ? "border-accent-500 bg-primary-900/80 text-primary-50" : "border-primary-700 bg-primary-900/40 text-primary-300 hover:border-primary-500 hover:text-primary-100"}`}
                    >
                        <span className="block truncate font-medium">{chat.title}</span>
                        <time
                            className="mt-1 block text-xs text-primary-400"
                            dateTime={chat.updatedAt}
                        >
                            {new Intl.DateTimeFormat("en-GB", {
                                day: "numeric",
                                month: "short",
                            }).format(new Date(chat.updatedAt))}
                        </time>
                    </Link>
                ))}
            </nav>
            {latest.data && conversations.length === 0 && (
                <p className="text-sm text-primary-400">No matching conversations.</p>
            )}
            {hasMore && (
                <Button
                    fullWidth
                    variant="secondary"
                    busy={history.isFetching}
                    onClick={() => {
                        setExpanded(filter);
                        if (history.data) void history.fetchNextPage();
                    }}
                >
                    Load more
                </Button>
            )}
        </Card>
    );
}
