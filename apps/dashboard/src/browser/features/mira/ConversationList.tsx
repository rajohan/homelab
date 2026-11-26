import type { MiraConversationCursor } from "@homelab/contracts/mira";
import {
    buttonStyles,
    ChoiceBar,
    IconButton,
    InfiniteScrollTrigger,
    LoadingState,
    queryRefresh,
    SearchInput,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PanelLeftClose, SquarePen } from "lucide-react";
import { Fragment, type Ref, useState } from "react";

import { api } from "../../api/client";

/**
 * Browse searchable conversations with explicit archive filtering and bounded pages.
 * @returns The same history list for the desktop rail and mobile history dialog.
 */
export function ConversationList({
    selected,
    onSelect,
    onCollapse,
    collapseRef,
    embedded = false,
    landing = false,
}: {
    readonly onCollapse?: () => void;
    readonly collapseRef?: Ref<HTMLButtonElement>;
    readonly embedded?: boolean;
    readonly landing?: boolean;
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
    let empty = archived ? "No archived conversations." : "No conversations yet.";
    if (search.trim()) empty = "No conversations match your search.";
    const today = new Date(latest.dataUpdatedAt);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const group = (value: string) => {
        const date = new Date(value);
        if (date.toDateString() === today.toDateString()) return "Today";
        if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
        return date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    };
    return (
        <div
            className={`flex min-h-0 w-full flex-col gap-3 ${embedded ? "max-h-[65dvh]" : "bg-surface-heading p-3"}`}
        >
            {!embedded && (
                <div className="flex min-h-10 items-center justify-between gap-2 pl-2">
                    <h2 className="text-sm font-semibold text-primary-100">
                        Chat history
                    </h2>
                    {onCollapse && (
                        <IconButton
                            icon={PanelLeftClose}
                            ref={collapseRef}
                            label="Hide chat history"
                            aria-expanded
                            onClick={onCollapse}
                        />
                    )}
                </div>
            )}
            {!landing && (
                <Link
                    to="/mira"
                    onClick={onSelect}
                    className={buttonStyles({ variant: "secondary", fullWidth: true })}
                >
                    <SquarePen size={16} aria-hidden="true" />
                    New chat
                </Link>
            )}
            <SearchInput
                label="Search conversations"
                value={search}
                onChange={setSearch}
                placeholder="Search history…"
            />
            <ChoiceBar
                fullWidth
                label="Conversation history"
                value={archived ? "archived" : "active"}
                options={[
                    { value: "active", label: "Active" },
                    { value: "archived", label: "Archived" },
                ]}
                onChange={(value) => setArchived(value === "archived")}
            />
            {latest.isPending && <LoadingState label="Loading conversations…" />}
            {latest.data && conversations.length === 0 && (
                <p className="px-1 text-sm text-primary-400">{empty}</p>
            )}
            <nav
                aria-label="Conversations"
                className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-0.5"
            >
                {conversations.map((chat, index) => (
                    <Fragment key={chat.id}>
                        {(!index ||
                            group(chat.updatedAt) !==
                                group(conversations[index - 1]!.updatedAt)) && (
                            <h3 className="px-2.5 pt-4 pb-1 text-xs font-medium text-primary-400">
                                {group(chat.updatedAt)}
                            </h3>
                        )}
                        <Link
                            title={chat.title}
                            to="/mira/$conversationId"
                            params={{ conversationId: chat.id }}
                            onClick={onSelect}
                            aria-current={selected === chat.id ? "page" : undefined}
                            className={`flex min-h-11 items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors ${selected === chat.id ? "bg-primary-700 text-primary-50" : "text-primary-300 hover:bg-primary-800 hover:text-primary-50"}`}
                        >
                            <span className="line-clamp-2 min-w-0 font-medium wrap-anywhere">
                                {chat.title}
                            </span>
                        </Link>
                    </Fragment>
                ))}
                <InfiniteScrollTrigger
                    itemCount={conversations.length}
                    hasMore={hasMore}
                    loading={history.isFetching}
                    refreshing={latest.isFetching}
                    error={latest.error ?? history.error ?? undefined}
                    onLoadMore={() => {
                        if (latest.isError) void latest.refetch();
                        else if (history.isError) void history.refetch();
                        else {
                            setExpanded(filter);
                            if (history.data) void history.fetchNextPage();
                        }
                    }}
                />
            </nav>
        </div>
    );
}
