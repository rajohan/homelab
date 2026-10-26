import type { MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
import {
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";

import { api } from "../../api/client";

/**
 * Select a recorded successful edit check without executing another job.
 * @returns Paginated owned results; the server independently validates the exact profile and input.
 */
export function CodeCheckPicker({
    conversationId,
    onSelect,
    onClose,
}: {
    readonly conversationId?: string | undefined;
    readonly onSelect: (job: MiraDaytonaJob, commit: string) => void;
    readonly onClose: () => void;
}) {
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "code-checks", conversationId],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.daytona.list.query({
                ...(conversationId ? { conversationId } : {}),
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const rows = (query.data?.pages.flatMap((page) => page.rows) ?? []).flatMap((job) => {
        const match =
            /^bun --no-env-file \/opt\/homelab\/daytona-check\.js ([a-f0-9-]+) ([a-f0-9]{40}) --edits ([a-f0-9]{64})$/.exec(
                job.content.command
            );
        return job.state === "completed" &&
            job.cleanup === "confirmed" &&
            job.exitCode === 0 &&
            match?.[1] === job.id
            ? [{ job, commit: match[2]! }]
            : [];
    });
    return (
        <Modal title="Choose a successful edit check" size="wide" onClose={onClose}>
            <div className="space-y-4">
                {query.isPending && <LoadingState label="Loading checks…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {rows.map(({ job, commit }) => (
                    <Card key={job.id} className="bg-primary-900/40">
                        <SectionHeader
                            title={job.content.title}
                            icon={CheckCheck}
                            description={`Base ${commit.slice(0, 12)}`}
                            actions={
                                <Button onClick={() => onSelect(job, commit)}>
                                    Choose check
                                </Button>
                            }
                        />
                    </Card>
                ))}
                {!query.isPending && rows.length === 0 && (
                    <p className="text-sm text-primary-400">
                        No successful structured-edit checks on this page. Complete an
                        edit check in Cloud jobs first.
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
