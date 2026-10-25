import type { MiraSocialDraft } from "@homelab/contracts/miraSocial";
import {
    ActionGroup,
    Badge,
    buttonStyles,
    Button,
    Card,
    ErrorNotice,
    FormField,
    Input,
    Modal,
    SectionHeader,
    formatDateTime,
} from "@homelab/ui";
import { ExternalLink, MessageSquare, Send } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Display immutable text/target approval and a separate operator-only provider challenge.
 * @returns Shared scroll-bounded review controls; no raw challenge instruction is executed.
 */
export function SocialReview({
    draft,
    onClose,
}: {
    readonly draft: MiraSocialDraft;
    readonly onClose: () => void;
}) {
    const [answer, setAnswer] = useState("");
    const approve = useOperation(() =>
        api.mira.social.approve.mutate({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedContent: draft.content,
        })
    );
    const verify = useOperation(() =>
        api.mira.social.verify.mutate({ id: draft.id, version: draft.version, answer })
    );
    const busy = approve.isPending || verify.isPending;
    const title =
        draft.content.kind === "post" ? draft.content.title : "Comment or reply";
    const postId =
        draft.content.kind === "post" ? draft.providerId : draft.content.postId;
    return (
        <Modal
            title={
                draft.state === "draft" ? "Review Moltbook draft" : "Moltbook submission"
            }
            onClose={onClose}
            dismissible={!busy}
            size="wide"
        >
            <div className="space-y-4">
                <Card className="space-y-4 bg-primary-900/40">
                    <SectionHeader
                        title={title}
                        icon={MessageSquare}
                        badge={<Badge>{draft.state.replaceAll("_", " ")}</Badge>}
                    />
                    <p className="text-sm wrap-anywhere text-primary-300">
                        Posting as {draft.agentName} ·{" "}
                        {draft.content.kind === "post"
                            ? `Community: ${draft.content.community}`
                            : `Post: ${draft.content.postId}${draft.content.parentId ? ` · Parent comment: ${draft.content.parentId}` : ""}`}
                    </p>
                    <div className="border-t border-primary-700 pt-4 text-sm wrap-anywhere whitespace-pre-wrap">
                        {draft.content.text}
                    </div>
                </Card>
                {draft.state === "draft" && (
                    <p className="text-sm text-primary-300">
                        This sends the exact text above to Moltbook as public content.
                        Moltbook may require an additional verification before it becomes
                        visible.
                    </p>
                )}
                {draft.message && (
                    <p className="text-sm text-primary-300">{draft.message}</p>
                )}
                {draft.providerId && (
                    <p className="text-xs wrap-anywhere text-primary-400">
                        Content ID: {draft.providerId}
                    </p>
                )}
                {draft.state === "verification_required" && draft.challenge && (
                    <Card className="space-y-4 bg-primary-900/40">
                        <SectionHeader
                            title="Provider verification"
                            icon={MessageSquare}
                        />
                        <p className="text-sm wrap-anywhere whitespace-pre-wrap">
                            {draft.challenge}
                        </p>
                        {draft.expiresAt && (
                            <p className="text-xs text-primary-400">
                                Expires {formatDateTime(draft.expiresAt)}
                            </p>
                        )}
                        <FormField
                            label="Answer"
                            description="Numeric answer with two decimal places, for example 15.00. One submission only; errors do not create another post."
                        >
                            <Input
                                value={answer}
                                onChange={(event) => setAnswer(event.target.value)}
                                maxLength={16}
                                inputMode="decimal"
                                autoComplete="off"
                            />
                        </FormField>
                    </Card>
                )}
                {(approve.error || verify.error) && (
                    <ErrorNotice error={approve.error ?? verify.error} />
                )}
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
                            <Send size={16} aria-hidden="true" />
                            Send publicly
                        </Button>
                    )}
                    {draft.state === "verification_required" && (
                        <Button
                            busy={verify.isPending}
                            disabled={!/^-?\d{1,12}\.\d{2}$/.test(answer)}
                            onClick={() =>
                                void verify
                                    .mutateAsync(undefined)
                                    .then(onClose)
                                    .catch(() => {})
                            }
                        >
                            Submit answer
                        </Button>
                    )}
                    {postId && (
                        <a
                            href={`https://www.moltbook.com/post/${encodeURIComponent(postId)}`}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonStyles({ variant: "secondary" })}
                        >
                            <ExternalLink size={16} aria-hidden="true" />
                            Open post
                        </a>
                    )}
                    <Button variant="secondary" disabled={busy} onClick={onClose}>
                        Close
                    </Button>
                </ActionGroup>
            </div>
        </Modal>
    );
}
