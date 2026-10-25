import type { MiraPublication } from "@homelab/contracts/miraPublication";
import {
    ActionGroup,
    Badge,
    buttonStyles,
    Button,
    Card,
    ErrorNotice,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { Download, ExternalLink, Globe, Upload } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Show the exact public destination and selected bytes before publication approval.
 * @returns Immutable review content and durable provider references using shared controls.
 */
export function PublicationReview({
    draft,
    onClose,
}: {
    readonly draft: MiraPublication;
    readonly onClose: () => void;
}) {
    const approve = useOperation(() =>
        api.mira.publications.approve.mutate({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedContent: draft.content,
        })
    );
    return (
        <Modal
            title={draft.state === "draft" ? "Review publication" : "Publication details"}
            onClose={onClose}
            dismissible={!approve.isPending}
            size="wide"
        >
            <div className="space-y-4">
                <Card className="space-y-4 bg-primary-900/40">
                    <SectionHeader
                        title={draft.content.title}
                        icon={Globe}
                        badge={<Badge>{draft.state.replaceAll("_", " ")}</Badge>}
                    />
                    <p className="text-sm text-primary-300">
                        {draft.content.target
                            ? `This replaces all existing files on ${draft.content.target.slug}.here.now. Changes made since the draft was prepared will stop publication.`
                            : "This creates a new here.now site."}{" "}
                        Anyone with the link can view every file below.
                    </p>
                    <div className="space-y-3 border-t border-primary-700 pt-4">
                        {draft.content.files.map((file) => (
                            <div
                                key={file.id}
                                className="flex flex-col gap-2 sm:flex-row sm:items-center"
                            >
                                <div className="min-w-0 flex-1 text-sm wrap-anywhere">
                                    <p>{file.path}</p>
                                    <p className="text-xs text-primary-400">
                                        {file.name} · {(file.bytes / 1024).toFixed(1)} KiB
                                        · {file.mediaType}
                                    </p>
                                </div>
                                <a
                                    href={`/api/mira/files/${file.id}`}
                                    download={file.name}
                                    className={buttonStyles({ variant: "secondary" })}
                                >
                                    <Download size={16} aria-hidden="true" />
                                    Download
                                </a>
                            </div>
                        ))}
                    </div>
                </Card>
                {draft.phase && <p className="text-sm text-primary-300">{draft.phase}</p>}
                {draft.message && (
                    <p className="text-sm text-primary-300">{draft.message}</p>
                )}
                {draft.state === "needs_attention" && draft.slug && (
                    <p className="text-xs wrap-anywhere text-primary-400">
                        Known site: {draft.slug} · Version:{" "}
                        {draft.providerVersionId ?? "Unknown"}
                    </p>
                )}
                {approve.error && <ErrorNotice error={approve.error} />}
                <ActionGroup>
                    {draft.state === "draft" && (
                        <Button
                            busy={approve.isPending}
                            onClick={() =>
                                void approve
                                    .mutateAsync(undefined)
                                    .then(onClose)
                                    .catch(() => {})
                            }
                        >
                            <Upload size={16} aria-hidden="true" />
                            Publish publicly
                        </Button>
                    )}
                    {draft.state === "published" && draft.slug && (
                        <a
                            href={`https://${draft.slug}.here.now/`}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonStyles({ variant: "secondary" })}
                        >
                            <ExternalLink size={16} aria-hidden="true" />
                            Open site
                        </a>
                    )}
                    {draft.state === "needs_attention" && (
                        <a
                            href="https://here.now/"
                            target="_blank"
                            rel="noreferrer"
                            className={buttonStyles({ variant: "secondary" })}
                        >
                            <ExternalLink size={16} aria-hidden="true" />
                            Open here.now
                        </a>
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
