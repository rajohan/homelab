import type { MiraAttachment } from "@homelab/contracts/mira";
import type { MiraPublication } from "@homelab/contracts/miraPublication";
import { ActionGroup, Button, ErrorNotice, FormField, Input, Modal } from "@homelab/ui";
import { Paperclip, X } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { FileLibrary } from "./FileLibrary";

/**
 * Prepare selected files and site paths without uploading or publishing.
 * @returns A versioned draft editor using the shared bounded modal and file library.
 */
export function PublicationEditor({
    draft,
    conversationId,
    onClose,
}: {
    readonly draft?: MiraPublication | undefined;
    readonly conversationId?: string | undefined;
    readonly onClose: () => void;
}) {
    const [id] = useState(() => draft?.id ?? crypto.randomUUID());
    const [title, setTitle] = useState(draft?.content.title ?? "");
    const [files, setFiles] = useState<(MiraAttachment & { path: string })[]>(() =>
        (draft?.content.files ?? []).map((file) => ({
            ...file,
            createdAt: draft!.createdAt,
        }))
    );
    const [selecting, setSelecting] = useState(false);
    const save = useOperation(() =>
        api.mira.publications.save.mutate({
            id,
            version: draft?.version ?? 0,
            conversationId: draft?.conversationId ?? conversationId ?? null,
            content: {
                title,
                target: draft?.content.target ?? null,
                visibility: "anyone_with_link",
                files: files.map(({ id, path }) => ({ id, path })),
            },
        })
    );
    if (selecting)
        return (
            <FileLibrary
                onClose={() => setSelecting(false)}
                onSelect={(file) => {
                    setFiles((current) =>
                        current.some((entry) => entry.id === file.id) ||
                        current.length >= 8
                            ? current
                            : [
                                  ...current,
                                  {
                                      ...file,
                                      path: file.name
                                          .replaceAll(/[^A-Za-z0-9._-]/g, "-")
                                          .replace(/^[^A-Za-z0-9]+/, "file-"),
                                  },
                              ]
                    );
                    setSelecting(false);
                }}
            />
        );
    return (
        <Modal
            title={draft ? "Edit publication draft" : "New publication draft"}
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
                <FormField label="Title">
                    <Input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        required
                        maxLength={80}
                    />
                </FormField>
                <p className="text-sm text-primary-300">
                    {draft?.content.target
                        ? `Replace the files on ${draft.content.target.slug}.here.now.`
                        : "Create a new here.now site."}{" "}
                    Anyone with the link will be able to view the published files.
                </p>
                <FormField
                    label="Published files"
                    description="Up to eight web, text, image or PDF files, totaling 25 MiB. Use index.html for a website's home page."
                >
                    <div className="space-y-3">
                        {files.map((file) => (
                            <div
                                key={file.id}
                                className="space-y-2 rounded-lg bg-primary-900/40 p-3"
                            >
                                <div className="flex items-center gap-3">
                                    <Paperclip
                                        size={16}
                                        aria-hidden="true"
                                        className="shrink-0 text-primary-400"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm wrap-anywhere">
                                            {file.name}
                                        </p>
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
                                <Input
                                    aria-label={`Published path for ${file.name}`}
                                    value={file.path}
                                    required
                                    maxLength={240}
                                    onChange={(event) =>
                                        setFiles((current) =>
                                            current.map((entry) =>
                                                entry.id === file.id
                                                    ? {
                                                          ...entry,
                                                          path: event.target.value,
                                                      }
                                                    : entry
                                            )
                                        )
                                    }
                                />
                            </div>
                        ))}
                        <Button
                            variant="secondary"
                            disabled={save.isPending || files.length >= 8}
                            onClick={() => setSelecting(true)}
                        >
                            <Paperclip size={16} aria-hidden="true" />
                            Choose file
                        </Button>
                    </div>
                </FormField>
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button
                        type="submit"
                        busy={save.isPending}
                        disabled={files.length === 0}
                    >
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
