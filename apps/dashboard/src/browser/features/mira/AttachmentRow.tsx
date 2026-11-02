import type { MiraAttachment } from "@homelab/contracts/mira";
import { Button, IconButton } from "@homelab/ui";
import { FileImage, FileText, X } from "lucide-react";

/**
 * Show a selected attachment with readable metadata, preview and a separate remove action.
 * @returns The same file row for the composer and attachment dialog.
 */
export function AttachmentRow({
    file,
    disabled,
    onPreview,
    onRemove,
}: {
    readonly file: MiraAttachment;
    readonly disabled: boolean;
    readonly onPreview: () => void;
    readonly onRemove: () => void;
}) {
    const image = file.mediaType.startsWith("image/");
    const documentType = file.mediaType === "application/pdf" ? "PDF" : "Text";
    return (
        <li className="flex min-w-0 items-center gap-1 rounded-lg border border-primary-700 bg-primary-800 p-1">
            <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start gap-2 px-2 text-left"
                aria-label={`Preview ${file.name}`}
                onClick={onPreview}
            >
                <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary-900">
                    {image ? (
                        <FileImage size={18} aria-hidden="true" />
                    ) : (
                        <FileText size={18} aria-hidden="true" />
                    )}
                </span>
                <span className="min-w-0">
                    <span className="block truncate text-sm">{file.name}</span>
                    <span className="block truncate text-xs font-normal text-primary-400">
                        {image ? "Image" : documentType}
                        {" · "}
                        {file.bytes >= 1_048_576
                            ? `${(file.bytes / 1_048_576).toFixed(1)} MiB`
                            : `${(file.bytes / 1024).toFixed(1)} KiB`}
                    </span>
                </span>
            </Button>
            <IconButton
                icon={X}
                label={`Remove ${file.name} from message`}
                disabled={disabled}
                onClick={onRemove}
            />
        </li>
    );
}
