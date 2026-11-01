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
import { useInfiniteQuery } from "@tanstack/react-query";
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
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "conversations", search, archived],
        initialPageParam: undefined as MiraConversationCursor | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.mira.conversations.list.query(
                { search, archived, ...(pageParam ? { before: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        ...queryRefresh("fast"),
    });
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
            {query.isPending && <LoadingState label="Loading conversations…" />}
            {query.error && <ErrorNotice error={query.error} />}
            <nav
                aria-label="Conversations"
                className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-0.5"
            >
                {query.data?.pages
                    .flatMap((page) => page.rows)
                    .map((chat) => (
                        <Link
                            key={chat.id}
                            to="/mira/$conversationId"
                            params={{ conversationId: chat.id }}
                            onClick={onSelect}
                            aria-current={selected === chat.id ? "page" : undefined}
                            className={`block rounded-lg border px-3 py-2.5 text-sm wrap-anywhere transition ${selected === chat.id ? "border-accent-500 bg-primary-900/80 text-primary-50" : "border-primary-700 bg-primary-900/40 text-primary-300 hover:border-primary-500 hover:text-primary-100"}`}
                        >
                            <span className="block truncate font-medium">
                                {chat.title}
                            </span>
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
            {query.data?.pages[0]?.rows.length === 0 && (
                <p className="text-sm text-primary-400">No matching conversations.</p>
            )}
            {query.hasNextPage && (
                <Button
                    fullWidth
                    variant="secondary"
                    busy={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                >
                    Load more
                </Button>
            )}
        </Card>
    );
}
