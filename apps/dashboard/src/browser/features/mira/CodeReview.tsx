import type { MiraCodePublication } from "@homelab/contracts/miraCode";
import {
    ActionGroup,
    Badge,
    Button,
    buttonStyles,
    Card,
    ErrorNotice,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import {
    CheckCheck as CheckCheckIcon,
    Download,
    ExternalLink,
    GitPullRequest,
    RefreshCw,
} from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { CodeFiles } from "./CodeFiles";

/**
 * Review exact tested edits and PR text, then follow durable publication and read-only recovery.
 * @returns A bounded shared dialog; only a fresh verified source can be approved.
 */
export function CodeReview({
    draft: initial,
    onClose,
}: {
    readonly draft: MiraCodePublication;
    readonly onClose: () => void;
}) {
    const current = useQuery({
        queryKey: ["operations", "mira", "code", initial.id],
        queryFn: () => api.mira.code.read.query({ id: initial.id }),
        initialData: initial,
        refetchInterval: 5000,
    });
    const draft = current.data;
    const source = useQuery({
        queryKey: ["operations", "mira", "code-source", draft.id, draft.contentHash],
        queryFn: () => api.mira.code.source.query({ id: draft.id }),
        enabled: draft.state === "draft",
    });
    const approve = useOperation(() =>
        api.mira.code.approve.mutate({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedContent: draft.content,
        })
    );
    const inspect = useOperation(() =>
        api.mira.code.inspect.mutate({ id: draft.id, version: draft.version })
    );
    const number = draft.number ?? draft.observation?.pullRequest?.number;
    return (
        <Modal
            title={draft.state === "draft" ? "Review code proposal" : "Code publication"}
            size="wide"
            onClose={onClose}
            dismissible={!approve.isPending}
        >
            <div className="space-y-4">
                <Card className="space-y-4 bg-primary-900/40">
                    <SectionHeader
                        title={draft.content.title}
                        icon={GitPullRequest}
                        badge={
                            <Badge
                                tone={
                                    draft.state === "needs_attention"
                                        ? "warning"
                                        : "neutral"
                                }
                            >
                                {draft.state.replaceAll("_", " ")}
                            </Badge>
                        }
                    />
                    <p className="text-sm text-primary-300">
                        Draft pull request in rajohan/homelab · Mira · Base{" "}
                        {draft.content.commit.slice(0, 12)}
                    </p>
                    <p className="text-sm wrap-anywhere whitespace-pre-wrap text-primary-300">
                        {draft.content.body}
                    </p>
                </Card>
                {draft.state === "draft" && (
                    <Card className="space-y-3 bg-primary-900/40">
                        <SectionHeader
                            title="Tested files"
                            icon={CheckCheckIcon}
                            description="Review the complete file replacements and deletions below."
                        />
                        {source.isPending && (
                            <LoadingState label="Verifying tested edits…" />
                        )}
                        {source.error && <ErrorNotice error={source.error} />}{" "}
                        {source.data && <CodeFiles files={source.data.plan.files} />}
                    </Card>
                )}
                {draft.message && (
                    <p className="text-sm text-primary-300">{draft.message}</p>
                )}
                {draft.branch && (
                    <p className="text-xs wrap-anywhere text-primary-400">
                        Branch: {draft.branch}
                    </p>
                )}
                {draft.phase && (
                    <p className="text-xs text-primary-400">
                        Last stage: {draft.phase.replaceAll("_", " ").replace(":", " · ")}
                    </p>
                )}
                {approve.error && <ErrorNotice error={approve.error} />}
                {inspect.error && <ErrorNotice error={inspect.error} />}
                <ActionGroup>
                    {draft.state === "draft" && (
                        <Button
                            busy={approve.isPending}
                            disabled={
                                current.isError ||
                                current.isFetching ||
                                source.isError ||
                                source.isFetching ||
                                source.data?.contentHash !== draft.contentHash
                            }
                            onClick={() =>
                                void approve
                                    .mutateAsync(undefined)
                                    .then(onClose)
                                    .catch(() => {})
                            }
                        >
                            <GitPullRequest size={16} aria-hidden="true" />
                            Create draft PR
                        </Button>
                    )}
                    <a
                        className={buttonStyles({ variant: "secondary" })}
                        href={`/api/mira/files/${draft.content.edits.id}`}
                        download="edits.json"
                    >
                        <Download size={16} />
                        Edit plan
                    </a>
                    {number && (
                        <a
                            className={buttonStyles({ variant: "secondary" })}
                            href={`https://github.com/rajohan/homelab/pull/${number}`}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <ExternalLink size={16} />
                            Open PR
                        </a>
                    )}
                    {["published", "needs_attention"].includes(draft.state) && (
                        <Button
                            variant="secondary"
                            busy={inspect.isPending || draft.inspectionRequested}
                            onClick={() =>
                                void inspect.mutateAsync(undefined).catch(() => {})
                            }
                        >
                            <RefreshCw size={16} />
                            Inspect GitHub
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        disabled={approve.isPending}
                        onClick={onClose}
                    >
                        Close
                    </Button>
                </ActionGroup>
            </div>
        </Modal>
    );
}
