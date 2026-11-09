import type { MiraAttachment } from "@homelab/contracts/mira";
import {
    ActionGroup,
    Button,
    ErrorNotice,
    FileDropZone,
    IconButton,
    LoadingState,
} from "@homelab/ui";
import { Paperclip } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import * as v from "valibot";

import { useOperation } from "../operations/useOperation";
import { AttachmentDialog } from "./AttachmentDialog";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentRow } from "./AttachmentRow";

const uploaded = v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.string(),
    mediaType: v.string(),
    bytes: v.number(),
    createdAt: v.string(),
});

/**
 * Upload selected files independently, preserving accepted attachments if another upload fails.
 * @returns Shared attachment controls with explicit file and count limits.
 */
export function AttachmentPicker({
    value,
    onChange,
    disabled = false,
    onBusyChange,
    onBrowse,
    compact = false,
    actions,
    controls,
    children,
}: {
    readonly value: MiraAttachment[];
    readonly onChange: (files: MiraAttachment[]) => void;
    readonly disabled?: boolean;
    readonly compact?: boolean;
    readonly actions?: ReactNode;
    readonly controls?: ReactNode;
    readonly children?: ReactNode;
    readonly onBrowse?: () => void;
    readonly onBusyChange?: (busy: boolean) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const uploading = useRef(false);
    const [open, setOpen] = useState(false);
    const [preview, setPreview] = useState<MiraAttachment>();
    const [remaining, setRemaining] = useState<{ file: File; id: string }[]>([]);
    const upload = useOperation(async (files: { file: File; id: string }[], signal) => {
        const accepted = [...value];
        onBusyChange?.(true);
        try {
            if (accepted.length + files.length > 8)
                throw new Error("Attach up to 8 files per message.");
            if (files.some(({ file }) => file.size === 0 || file.size > 26_214_400))
                throw new Error("Each file must be between 1 byte and 25 MiB.");
            setRemaining(files);
            for (const [index, entry] of files.entries()) {
                const { file, id } = entry;
                if (file.size === 0 || file.size > 26_214_400)
                    throw new Error("Each file must be between 1 byte and 25 MiB.");
                const response = await fetch("/api/mira/files", {
                    method: "POST",
                    body: file,
                    signal,
                    headers: {
                        "x-file-id": id,
                        "x-file-name": encodeURIComponent(file.name),
                        "content-type": "application/octet-stream",
                    },
                });
                if (!response.ok)
                    throw new Error(
                        "The file could not be uploaded. Use PNG, JPEG, WebP, PDF or UTF-8 text and check your connection."
                    );
                accepted.push(v.parse(uploaded, await response.json()));
                onChange([...accepted]);
                setRemaining(files.slice(index + 1));
            }
        } finally {
            uploading.current = false;
            onBusyChange?.(false);
        }
    });
    const blocked =
        disabled || upload.isPending || remaining.length > 0 || value.length >= 8;
    const addFiles = (files: File[]) => {
        if (blocked || uploading.current || files.length === 0) return;
        uploading.current = true;
        upload.mutate(files.map((file) => ({ file, id: crypto.randomUUID() })));
    };
    const files = (
        <>
            {value.length > 0 && (
                <ul
                    className={
                        open
                            ? "max-h-[min(42dvh,24rem)] space-y-2 overflow-y-auto"
                            : "grid max-h-36 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2"
                    }
                >
                    {value.map((file) => (
                        <AttachmentRow
                            key={file.id}
                            file={file}
                            disabled={disabled || upload.isPending}
                            onPreview={() => setPreview(file)}
                            onRemove={() =>
                                onChange(value.filter((entry) => entry.id !== file.id))
                            }
                        />
                    ))}
                </ul>
            )}
            {upload.isPending && (
                <LoadingState
                    label={
                        remaining[0]
                            ? `Uploading ${remaining[0].file.name} · ${remaining.length} remaining`
                            : "Preparing files…"
                    }
                />
            )}
            {upload.error && <ErrorNotice error={upload.error} />}
            {remaining.length > 0 && !upload.isPending && (
                <ActionGroup>
                    <Button
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => {
                            if (uploading.current) return;
                            uploading.current = true;
                            upload.mutate(remaining);
                        }}
                    >
                        Retry upload
                    </Button>
                    <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => {
                            setRemaining([]);
                            upload.reset();
                        }}
                    >
                        Discard failed uploads
                    </Button>
                </ActionGroup>
            )}
        </>
    );
    return (
        <FileDropZone
            disabled={blocked}
            onFiles={addFiles}
            className="@container/attachment-picker flex min-w-0 flex-col gap-2"
        >
            {children}
            <input
                ref={input}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,application/json,.txt,.json,.csv,.md,.yaml,.yml,.ts,.tsx,.js,.py,.sh,.log"
                className="hidden"
                aria-label="Choose local attachments"
                onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = "";
                    addFiles(files);
                }}
                disabled={disabled || upload.isPending || remaining.length > 0}
            />
            <div
                className={
                    compact
                        ? "order-last -mx-2 flex min-w-0 flex-wrap items-center gap-1 border-t border-primary-700 px-2 pt-2"
                        : "flex flex-col gap-2 min-[30rem]:flex-row"
                }
            >
                {compact ? (
                    <IconButton
                        icon={Paperclip}
                        label="Attach files"
                        busy={upload.isPending}
                        disabled={disabled || value.length >= 8 || remaining.length > 0}
                        onClick={() => setOpen(true)}
                    />
                ) : (
                    <Button
                        variant="secondary"
                        busy={upload.isPending}
                        disabled={disabled || value.length >= 8 || remaining.length > 0}
                        onClick={() => setOpen(true)}
                    >
                        <Paperclip size={16} aria-hidden="true" />
                        Attach files
                    </Button>
                )}
                {controls}
                {actions && (
                    <div
                        className={
                            compact
                                ? "ml-auto flex w-full shrink-0 items-center gap-2 @min-[18rem]/attachment-picker:w-auto [&>button]:flex-1 @min-[18rem]/attachment-picker:[&>button]:flex-none"
                                : "ml-auto flex shrink-0 items-center gap-2"
                        }
                    >
                        {actions}
                    </div>
                )}
            </div>
            {!open && !preview && files}
            {open && !preview && (
                <AttachmentDialog
                    disabled={blocked}
                    count={value.length}
                    onFiles={addFiles}
                    onChoose={() => input.current?.click()}
                    onBrowse={
                        onBrowse
                            ? () => {
                                  setOpen(false);
                                  onBrowse();
                              }
                            : undefined
                    }
                    onClose={() => setOpen(false)}
                >
                    {files}
                </AttachmentDialog>
            )}
            {preview && (
                <AttachmentPreview file={preview} onClose={() => setPreview(undefined)} />
            )}
        </FileDropZone>
    );
}
