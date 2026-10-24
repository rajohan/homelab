import type { MiraMemory } from "@homelab/contracts/mira";
import {
    DropdownMenu,
    Button,
    Card,
    ConfirmDialog,
    ErrorNotice,
    LoadingState,
    Markdown,
    Modal,
    SearchInput,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MemoryEditor } from "./MemoryEditor";

/**
 * Inspect, search and manage the explicit memory available to Mira's tools.
 * @returns A bounded library that preserves audit history when memory content is removed.
 */
export function MemoryLibrary({ onClose }: { readonly onClose: () => void }) {
    const [search, setSearch] = useState("");
    const [editing, setEditing] = useState<MiraMemory | "new">();
    const [deleting, setDeleting] = useState<MiraMemory>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "memory", search],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.memory.list.query({
                search,
                archived: false,
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const remove = useOperation((memory: MiraMemory) =>
        api.mira.memory.delete.mutate({ id: memory.id, version: memory.version })
    );
    if (editing)
        return (
            <MemoryEditor
                memory={editing === "new" ? undefined : editing}
                onClose={() => setEditing(undefined)}
            />
        );
    if (deleting)
        return (
            <ConfirmDialog
                title="Delete memory"
                description="Remove this memory from Mira's tools. Previous conversation messages remain in their own history."
                confirmLabel="Delete memory"
                onClose={() => setDeleting(undefined)}
                onConfirm={async () => {
                    await remove.mutateAsync(deleting);
                    setDeleting(undefined);
                }}
            />
        );
    return (
        <Modal title="Mira memory" onClose={onClose} size="wide">
            <div className="space-y-4">
                <SectionHeader
                    title="Remembered context"
                    icon={Brain}
                    compactActions
                    actions={
                        <Button onClick={() => setEditing("new")}>
                            <Plus size={16} aria-hidden="true" />
                            New memory
                        </Button>
                    }
                />
                <SearchInput label="Search memory" value={search} onChange={setSearch} />
                {query.isPending && <LoadingState label="Loading memory…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {query.data?.pages
                    .flatMap((page) => page.rows)
                    .map((memory) => (
                        <Card key={memory.id} className="space-y-3 bg-primary-900/40">
                            <SectionHeader
                                title={memory.title}
                                icon={Brain}
                                compactActions
                                actions={
                                    <DropdownMenu
                                        label={`Actions for ${memory.title}`}
                                        actions={[
                                            {
                                                id: "edit",
                                                label: "Edit",
                                                icon: Pencil,
                                                onSelect: () => setEditing(memory),
                                            },
                                            {
                                                id: "delete",
                                                label: "Delete",
                                                icon: Trash2,
                                                danger: true,
                                                onSelect: () => setDeleting(memory),
                                            },
                                        ]}
                                    />
                                }
                            />
                            <Markdown>{memory.content}</Markdown>
                        </Card>
                    ))}
                {query.data?.pages[0]?.rows.length === 0 && (
                    <p className="text-sm text-primary-400">
                        No matching memories. Add context here, or ask Mira to remember
                        something.
                    </p>
                )}
                {query.hasNextPage && (
                    <Button
                        variant="secondary"
                        fullWidth
                        busy={query.isFetchingNextPage}
                        onClick={() => void query.fetchNextPage()}
                    >
                        Load more
                    </Button>
                )}
            </div>
        </Modal>
    );
}
