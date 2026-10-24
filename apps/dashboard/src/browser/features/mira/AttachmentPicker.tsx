import type { MiraAttachment } from "@homelab/contracts/mira";
import { ActionGroup, Button, ErrorNotice, IconButton } from "@homelab/ui";
import { Files, Paperclip, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import * as v from "valibot";

import { useOperation } from "../operations/useOperation";

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
}: {
    readonly value: MiraAttachment[];
    readonly onChange: (files: MiraAttachment[]) => void;
    readonly disabled?: boolean;
    readonly compact?: boolean;
    readonly actions?: ReactNode;
    readonly controls?: ReactNode;
    readonly onBrowse?: () => void;
    readonly onBusyChange?: (busy: boolean) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [remaining, setRemaining] = useState<{ file: File; id: string }[]>([]);
    const upload = useOperation(async (files: { file: File; id: string }[], signal) => {
        const accepted = [...value];
        if (accepted.length + files.length > 8)
            throw new Error("Attach up to 8 files per message.");
        onBusyChange?.(true);
        setRemaining(files);
        try {
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
            onBusyChange?.(false);
        }
    });
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <input
                ref={input}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,application/json,.txt,.json,.csv,.md,.yaml,.yml,.ts,.tsx,.js,.py,.sh,.log"
                className="hidden"
                aria-label="Attach files"
                onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = "";
                    if (files.length > 0)
                        upload.mutate(
                            files.map((file) => ({ file, id: crypto.randomUUID() }))
                        );
                }}
                disabled={disabled || upload.isPending || remaining.length > 0}
            />
            <div
                className={
                    compact
                        ? "order-last -mx-2 flex min-w-0 items-center gap-1 border-t border-primary-700 px-2 pt-2"
                        : "flex flex-col gap-2 min-[30rem]:flex-row"
                }
            >
                {compact ? (
                    <IconButton
                        icon={Paperclip}
                        label="Upload files"
                        busy={upload.isPending}
                        disabled={disabled || value.length >= 8 || remaining.length > 0}
                        onClick={() => input.current?.click()}
                    />
                ) : (
                    <Button
                        variant="secondary"
                        busy={upload.isPending}
                        disabled={disabled || value.length >= 8 || remaining.length > 0}
                        onClick={() => input.current?.click()}
                    >
                        <Paperclip size={16} aria-hidden="true" />
                        Attach files
                    </Button>
                )}
                {onBrowse &&
                    (compact ? (
                        <IconButton
                            icon={Files}
                            label="Choose existing files"
                            onClick={onBrowse}
                            disabled={disabled || upload.isPending || value.length >= 8}
                        />
                    ) : (
                        <Button
                            variant="secondary"
                            onClick={onBrowse}
                            disabled={disabled || upload.isPending || value.length >= 8}
                        >
                            <Files size={16} aria-hidden="true" />
                            Choose existing
                        </Button>
                    ))}
                {controls}
                {actions && (
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                        {actions}
                    </div>
                )}
            </div>
            {value.length > 0 && (
                <ul className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
                    {value.map((file) => (
                        <li
                            key={file.id}
                            className="flex min-w-0 items-center gap-2 rounded-lg border border-primary-700 bg-primary-800 px-3 py-1 text-sm"
                        >
                            <span className="max-w-48 truncate">{file.name}</span>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Remove ${file.name} from message`}
                                disabled={upload.isPending || disabled}
                                onClick={() =>
                                    onChange(
                                        value.filter((entry) => entry.id !== file.id)
                                    )
                                }
                            >
                                <X size={14} aria-hidden="true" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {upload.error && <ErrorNotice error={upload.error} />}
            {remaining.length > 0 && !upload.isPending && (
                <ActionGroup>
                    <Button
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => upload.mutate(remaining)}
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
        </div>
    );
}
