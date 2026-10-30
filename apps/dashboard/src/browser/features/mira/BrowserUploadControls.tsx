import type {
    MiraBrowserPreview,
    miraBrowserHumanCommandSchema,
} from "@homelab/contracts/miraBrowser";
import {
    ActionGroup,
    Button,
    ConfirmDialog,
    ErrorNotice,
    FormField,
    Select,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";

type Operation = v.InferOutput<typeof miraBrowserHumanCommandSchema>["operation"];
type UploadOperation = Extract<Operation, { method: "upload" }>;

/**
 * Select a conversation attachment and confirm its disclosure to the observed website.
 * @returns Shared file/element controls with a confirmation bound to one observation and file digest.
 */
export function BrowserUploadControls({
    accessId,
    preview,
    disabled,
    now,
    onCommand,
}: {
    readonly accessId: string;
    readonly preview: MiraBrowserPreview | null;
    readonly disabled: boolean;
    readonly now: number;
    readonly onCommand: (operation: Operation) => void;
}) {
    const [fileId, setFileId] = useState("");
    const [ref, setRef] = useState("");
    const [confirmation, setConfirmation] = useState<UploadOperation | null>(null);
    const files = useQuery({
        queryKey: ["operations", "mira", "browser-uploads", accessId],
        queryFn: ({ signal }) =>
            api.mira.browser.uploads.query({ id: accessId }, { signal }),
        refetchInterval: 5000,
        retry: false,
        gcTime: 0,
    });
    const selected = files.data?.find((file) => file.id === fileId);
    const targets = preview?.refs.filter((item) => item.actions.includes("upload")) ?? [];
    const target = targets.find((item) => item.ref === ref);
    const unavailable =
        disabled ||
        files.isPending ||
        Boolean(files.error) ||
        now - files.dataUpdatedAt >= 10_000;
    const current =
        confirmation &&
        !unavailable &&
        preview?.observationId === confirmation.input.observationId &&
        new URL(preview.url).origin === confirmation.origin &&
        targets.some((item) => item.ref === confirmation.input.ref) &&
        files.data?.some(
            (file) =>
                file.id === confirmation.file.id &&
                file.sha256 === confirmation.file.sha256 &&
                file.name === confirmation.file.name &&
                file.size === confirmation.file.size
        );
    return (
        <section
            className="space-y-3 border-t border-primary-700 pt-4"
            aria-label="Upload an attachment"
        >
            <FormField
                label="Conversation attachment"
                description="Choose a file already attached to this conversation."
            >
                <Select
                    value={fileId}
                    onChange={setFileId}
                    disabled={unavailable}
                    options={[
                        { value: "", label: "Choose an attachment" },
                        ...(files.data ?? []).map((file) => ({
                            value: file.id,
                            label: (
                                <span className="block wrap-anywhere whitespace-normal">
                                    {file.name} · {file.size.toLocaleString("en-US")}{" "}
                                    bytes · {file.id}
                                </span>
                            ),
                        })),
                    ]}
                />
            </FormField>
            <FormField
                label="File input on the page"
                description="Refresh the view if the file input is missing."
            >
                <Select
                    value={ref}
                    onChange={setRef}
                    disabled={unavailable}
                    options={[
                        { value: "", label: "Choose a file input" },
                        ...targets.map((item) => ({
                            value: item.ref,
                            label: item.label || item.ref,
                        })),
                    ]}
                />
            </FormField>
            {files.error && <ErrorNotice error={files.error} />}
            <ActionGroup>
                <Button
                    variant="secondary"
                    disabled={unavailable || !selected || !target || !preview}
                    onClick={() => {
                        if (selected && target && preview)
                            setConfirmation({
                                method: "upload",
                                input: {
                                    observationId: preview.observationId,
                                    ref: target.ref,
                                },
                                origin: new URL(preview.url).origin,
                                file: { ...selected },
                            });
                    }}
                >
                    <Upload size={14} aria-hidden="true" />
                    Review upload
                </Button>
            </ActionGroup>
            {confirmation && (
                <ConfirmDialog
                    title="Upload attachment"
                    description="The website can read this file as soon as you continue, even before you submit its form."
                    confirmLabel="Send file to website"
                    variant="primary"
                    confirmDisabled={!current}
                    onClose={() => setConfirmation(null)}
                    onConfirm={() => {
                        if (current) {
                            onCommand(confirmation);
                            setConfirmation(null);
                        }
                        return Promise.resolve();
                    }}
                >
                    <dl className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm wrap-anywhere">
                        <div>
                            <dt className="text-primary-400">File</dt>
                            <dd>
                                {confirmation.file.name} ·{" "}
                                {confirmation.file.size.toLocaleString("en-US")} bytes
                            </dd>
                        </div>
                        <div>
                            <dt className="text-primary-400">Attachment ID</dt>
                            <dd>{confirmation.file.id}</dd>
                        </div>
                        <div>
                            <dt className="text-primary-400">Website</dt>
                            <dd>{confirmation.origin}</dd>
                        </div>
                    </dl>
                    {!current && (
                        <p className="text-sm text-primary-400">
                            The view or attachment changed. Cancel and refresh before
                            confirming again.
                        </p>
                    )}
                </ConfirmDialog>
            )}
        </section>
    );
}
