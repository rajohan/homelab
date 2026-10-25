import type { MiraMailDraft } from "@homelab/contracts/miraMail";
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
import { Mail, Send, Paperclip, Download } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Present the submitted content and provider footer disclosure before approval.
 * @returns An immutable review snapshot; stale versions cannot approve changed content.
 */
export function MailReview({
    draft,
    onClose,
}: {
    readonly draft: MiraMailDraft;
    readonly onClose: () => void;
}) {
    const approve = useOperation(() =>
        api.mira.mail.approve.mutate({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedReply: draft.content.reply ?? null,
            reviewedAttachments: draft.content.attachments ?? [],
        })
    );
    return (
        <Modal
            title={
                draft.state === "draft" ? "Review email before sending" : "Email delivery"
            }
            onClose={onClose}
            dismissible={!approve.isPending}
            size="wide"
        >
            <div className="space-y-4">
                <Card className="space-y-4 bg-primary-900/40">
                    <SectionHeader
                        title={draft.content.subject}
                        icon={Mail}
                        badge={<Badge>{draft.state.replaceAll("_", " ")}</Badge>}
                    />
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                        <dt className="whitespace-nowrap text-primary-400">From</dt>
                        <dd className="wrap-break-word">{draft.inboxId}</dd>
                        <dt className="whitespace-nowrap text-primary-400">To</dt>
                        <dd className="wrap-break-word">{draft.content.to.join(", ")}</dd>
                        <dt className="whitespace-nowrap text-primary-400">Cc</dt>
                        <dd className="wrap-break-word">
                            {draft.content.cc.join(", ") || "None"}
                        </dd>
                        <dt className="whitespace-nowrap text-primary-400">Bcc</dt>
                        <dd className="wrap-break-word">
                            {draft.content.bcc.join(", ") || "None"}
                        </dd>
                        {draft.content.reply && (
                            <>
                                <dt className="whitespace-nowrap text-primary-400">
                                    Thread
                                </dt>
                                <dd className="wrap-break-word">
                                    {draft.content.reply.subject || "(no subject)"}
                                </dd>
                                <dt className="whitespace-nowrap text-primary-400">
                                    Original sender
                                </dt>
                                <dd className="wrap-break-word">
                                    {draft.content.reply.from}
                                </dd>
                                {(draft.content.reply.replyTo?.length ?? 0) > 0 && (
                                    <>
                                        <dt className="whitespace-nowrap text-primary-400">
                                            Original Reply-To
                                        </dt>
                                        <dd className="wrap-break-word">
                                            {draft.content.reply.replyTo!.join(", ")}
                                        </dd>
                                    </>
                                )}
                            </>
                        )}
                    </dl>
                    {(draft.content.attachments?.length ?? 0) > 0 && (
                        <div className="space-y-2 border-t border-primary-700 pt-4">
                            <SectionHeader title="Attachments" icon={Paperclip} />
                            {draft.content.attachments!.map((file) => (
                                <div
                                    key={file.id}
                                    className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center"
                                >
                                    <span className="min-w-0 flex-1 wrap-anywhere">
                                        {file.name}{" "}
                                        <span className="text-primary-400">
                                            ({(file.bytes / 1024).toFixed(1)} KiB ·{" "}
                                            {file.mediaType})
                                        </span>
                                    </span>
                                    <a
                                        href={`/api/mira/files/${file.id}`}
                                        className={buttonStyles({ variant: "secondary" })}
                                        download={file.name}
                                    >
                                        <Download size={16} aria-hidden="true" />
                                        Download
                                    </a>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="border-t border-primary-700 pt-4 text-sm wrap-anywhere whitespace-pre-wrap">
                        {draft.content.text}
                    </div>
                </Card>
                <p className="text-sm text-primary-300">
                    AgentMail adds a “Sent via AgentMail” footer on its free plan. Paid
                    plans send without this footer.
                </p>
                {draft.message && (
                    <p className="text-sm text-primary-300">{draft.message}</p>
                )}
                {draft.providerMessageId && (
                    <p className="text-xs break-all text-primary-400">
                        Message ID: {draft.providerMessageId}
                    </p>
                )}
                {draft.providerThreadId && (
                    <p className="text-xs break-all text-primary-400">
                        Thread ID: {draft.providerThreadId}
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
                            <Send size={16} aria-hidden="true" />
                            Confirm and send
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
