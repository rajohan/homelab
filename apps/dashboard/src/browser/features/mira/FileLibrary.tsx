import type { MiraAttachment } from "@homelab/contracts/mira";
import {
    DropdownMenu,
    Button,
    Card,
    ConfirmDialog,
    ErrorNotice,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Eye, File, Paperclip, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { AttachmentPreview } from "./AttachmentPreview";

/**
 * Manage uploaded files, including unused uploads, without exposing storage paths.
 * @returns A paginated library with preview, optional attachment selection and deletion.
 */
export function FileLibrary({
    onClose,
    onSelect,
}: {
    readonly onClose: () => void;
    readonly onSelect?: (file: MiraAttachment) => void;
}) {
    const [preview, setPreview] = useState<MiraAttachment>();
    const [deleting, setDeleting] = useState<MiraAttachment>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "files"],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.files.list.query({
                search: "",
                archived: false,
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const remove = useOperation(async (file: MiraAttachment, signal) => {
        const response = await fetch(`/api/mira/files/${file.id}`, {
            method: "DELETE",
            signal,
        });
        if (!response.ok)
            throw new Error("The file could not be removed. Refresh and try again.");
    });
    if (preview)
        return <AttachmentPreview file={preview} onClose={() => setPreview(undefined)} />;
    if (deleting)
        return (
            <ConfirmDialog
                title="Delete file"
                description="Remove the stored file. Messages that referenced it will show that it is unavailable. Content already shared in a conversation remains in that conversation until it is deleted."
                confirmLabel="Delete file"
                onClose={() => setDeleting(undefined)}
                onConfirm={async () => {
                    await remove.mutateAsync(deleting);
                    setDeleting(undefined);
                }}
            />
        );
    return (
        <Modal title="Mira files" onClose={onClose} size="wide">
            <div className="space-y-4">
                {query.isPending && <LoadingState label="Loading files…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {query.data?.pages
                    .flatMap((page) => page.rows)
                    .map((file) => (
                        <Card key={file.id} className="space-y-3 bg-primary-900/40">
                            <SectionHeader
                                title={file.name}
                                icon={File}
                                description={`${(file.bytes / 1024).toFixed(1)} KiB`}
                                compactActions
                                actions={
                                    <DropdownMenu
                                        label={`Actions for ${file.name}`}
                                        actions={[
                                            {
                                                id: "preview",
                                                label: "Preview",
                                                icon: Eye,
                                                onSelect: () => setPreview(file),
                                            },
                                            ...(onSelect
                                                ? [
                                                      {
                                                          id: "attach",
                                                          label: "Attach",
                                                          icon: Paperclip,
                                                          onSelect: () => onSelect(file),
                                                      },
                                                  ]
                                                : []),
                                            {
                                                id: "delete",
                                                label: "Delete",
                                                icon: Trash2,
                                                danger: true,
                                                onSelect: () => setDeleting(file),
                                            },
                                        ]}
                                    />
                                }
                            />
                        </Card>
                    ))}
                {query.data?.pages[0]?.rows.length === 0 && (
                    <p className="text-sm text-primary-400">No uploaded files.</p>
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
