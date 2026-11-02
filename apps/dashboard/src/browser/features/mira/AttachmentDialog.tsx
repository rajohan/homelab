import { ActionGroup, Button, FileDropZone, Modal } from "@homelab/ui";
import { Files, Upload } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Present local uploads and previously stored files in a scrollable attachment chooser.
 * @returns A shared web/Windows dialog with file dropping, selection and upload feedback.
 */
export function AttachmentDialog({
    disabled,
    count,
    children,
    onFiles,
    onChoose,
    onBrowse,
    onClose,
}: {
    readonly disabled: boolean;
    readonly count: number;
    readonly children: ReactNode;
    readonly onFiles: (files: File[]) => void;
    readonly onChoose: () => void;
    readonly onBrowse?: (() => void) | undefined;
    readonly onClose: () => void;
}) {
    return (
        <Modal
            title="Attach files"
            description="Up to 8 files, 25 MiB each. Images, PDF and text."
            onClose={onClose}
        >
            <div className="space-y-4">
                <FileDropZone disabled={disabled} onFiles={onFiles}>
                    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-primary-600 bg-primary-900 p-6 text-center">
                        <Upload
                            size={24}
                            aria-hidden="true"
                            className="text-primary-400"
                        />
                        <p className="text-sm text-primary-200">
                            Drop files here or choose from your device
                        </p>
                        <Button
                            variant="secondary"
                            disabled={disabled}
                            onClick={onChoose}
                        >
                            Choose files
                        </Button>
                    </div>
                </FileDropZone>
                <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">Selected files</span>
                    <span className="text-primary-400">{count}/8</span>
                </div>
                {children}
                <ActionGroup>
                    <Button onClick={onClose}>Done</Button>
                    {onBrowse && (
                        <Button
                            variant="secondary"
                            disabled={disabled}
                            onClick={onBrowse}
                        >
                            <Files size={16} aria-hidden="true" />
                            Choose existing
                        </Button>
                    )}
                </ActionGroup>
            </div>
        </Modal>
    );
}
