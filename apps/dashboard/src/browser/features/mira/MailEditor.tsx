import type { MiraAttachment } from "@homelab/contracts/mira";
import type { MiraMailDraft } from "@homelab/contracts/miraMail";
import {
    ActionGroup,
    Button,
    ErrorNotice,
    FormField,
    Input,
    Modal,
    Textarea,
} from "@homelab/ui";
import { Paperclip, X } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { FileLibrary } from "./FileLibrary";

const addresses = (value: string) =>
    value
        .split(/[;,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean);

/**
 * Edit local email content without granting authority to transmit it.
 * @returns A version-checked plain-text composer using the shared bounded modal.
 */
export function MailEditor({
    draft,
    conversationId,
    onClose,
}: {
    readonly draft?: MiraMailDraft | undefined;
    readonly conversationId?: string | undefined;
    readonly onClose: () => void;
}) {
    const [id] = useState(() => draft?.id ?? crypto.randomUUID());
    const [to, setTo] = useState(draft?.content.to.join(", ") ?? "");
    const [cc, setCc] = useState(draft?.content.cc.join(", ") ?? "");
    const [bcc, setBcc] = useState(draft?.content.bcc.join(", ") ?? "");
    const [subject, setSubject] = useState(draft?.content.subject ?? "");
    const [text, setText] = useState(draft?.content.text ?? "");
    const [files, setFiles] = useState<MiraAttachment[]>(() =>
        (draft?.content.attachments ?? []).map((file) => ({
            ...file,
            createdAt: draft!.createdAt,
        }))
    );
    const [selectingFiles, setSelectingFiles] = useState(false);
    const save = useOperation(() =>
        api.mira.mail.save.mutate({
            id,
            version: draft?.version ?? 0,
            conversationId: draft?.conversationId ?? conversationId ?? null,
            content: {
                to: addresses(to),
                cc: addresses(cc),
                bcc: addresses(bcc),
                subject,
                text,
                attachmentIds: files.map((file) => file.id),
            },
        })
    );
    if (selectingFiles)
        return (
            <FileLibrary
                onClose={() => setSelectingFiles(false)}
                onSelect={(file) => {
                    setFiles((current) =>
                        current.some((entry) => entry.id === file.id)
                            ? current
                            : [...current, file]
                    );
                    setSelectingFiles(false);
                }}
            />
        );
    return (
        <Modal
            title={draft ? "Edit email draft" : "New email draft"}
            onClose={onClose}
            dismissible={!save.isPending}
            size="wide"
        >
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save
                        .mutateAsync(undefined)
                        .then(onClose)
                        .catch(() => {});
                }}
            >
                <FormField label="To" description="Separate addresses with commas.">
                    <Input
                        value={to}
                        onChange={(event) => setTo(event.target.value)}
                        required
                        maxLength={6500}
                    />
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label="Cc">
                        <Input
                            value={cc}
                            onChange={(event) => setCc(event.target.value)}
                            maxLength={6500}
                        />
                    </FormField>
                    <FormField label="Bcc">
                        <Input
                            value={bcc}
                            onChange={(event) => setBcc(event.target.value)}
                            maxLength={6500}
                        />
                    </FormField>
                </div>
                <FormField
                    label="Subject"
                    description={
                        draft?.content.reply
                            ? "Replies keep the original email thread and subject."
                            : undefined
                    }
                >
                    <Input
                        value={subject}
                        readOnly={Boolean(draft?.content.reply)}
                        onChange={(event) => setSubject(event.target.value)}
                        required
                        maxLength={200}
                    />
                </FormField>
                <FormField label="Message">
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        required
                        maxLength={48_000}
                        className="min-h-48"
                    />
                </FormField>
                <FormField
                    label="Attachments"
                    description="Up to five uploaded files, totaling 4 MiB. Files are checked again before sending."
                >
                    <div className="space-y-2">
                        {files.map((file) => (
                            <div
                                key={file.id}
                                className="flex items-center gap-3 rounded-lg bg-primary-900/40 p-3"
                            >
                                <Paperclip
                                    size={16}
                                    aria-hidden="true"
                                    className="shrink-0 text-primary-400"
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm wrap-anywhere">{file.name}</p>
                                    <p className="text-xs text-primary-400">
                                        {(file.bytes / 1024).toFixed(1)} KiB
                                    </p>
                                </div>
                                <Button
                                    variant="ghost"
                                    aria-label={`Remove ${file.name}`}
                                    onClick={() =>
                                        setFiles((current) =>
                                            current.filter(
                                                (entry) => entry.id !== file.id
                                            )
                                        )
                                    }
                                >
                                    <X size={16} aria-hidden="true" />
                                </Button>
                            </div>
                        ))}
                        <Button
                            variant="secondary"
                            disabled={save.isPending || files.length >= 5}
                            onClick={() => setSelectingFiles(true)}
                        >
                            <Paperclip size={16} aria-hidden="true" />
                            Choose file
                        </Button>
                    </div>
                </FormField>
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button type="submit" busy={save.isPending}>
                        Save draft
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={save.isPending}
                        onClick={onClose}
                    >
                        Cancel
                    </Button>
                </ActionGroup>
            </form>
        </Modal>
    );
}
