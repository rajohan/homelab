import type { MiraAttachment } from "@homelab/contracts/mira";
import { ActionGroup, buttonStyles, ErrorNotice, LoadingState, Modal } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import * as v from "valibot";

/**
 * Preview passive images or bounded extracted document text in the shared scrollable modal.
 * @returns A safe preview and a direct authenticated download of the original file.
 */
export function AttachmentPreview({
    file,
    onClose,
}: {
    readonly file: MiraAttachment;
    readonly onClose: () => void;
}) {
    const image = file.mediaType.startsWith("image/");
    const url = `/api/mira/files/${file.id}`;
    const text = useQuery({
        queryKey: ["operations", "mira", "file-text", file.id],
        enabled: !image,
        queryFn: async ({ signal }) => {
            const response = await fetch(`${url}?preview=text`, { signal });
            if (!response.ok)
                throw new Error(
                    "The document preview is unavailable. You can download the original file."
                );
            return v.parse(
                v.object({ text: v.string(), truncated: v.boolean() }),
                await response.json()
            );
        },
    });
    return (
        <Modal title={file.name} onClose={onClose} size="wide">
            <div className="space-y-4">
                {image && (
                    <img
                        src={`${url}?preview=1`}
                        alt={file.name}
                        className="mx-auto max-h-[60dvh] max-w-full rounded-lg object-contain"
                    />
                )}
                {!image && text.isPending && <LoadingState label="Reading document…" />}
                {text.error && <ErrorNotice error={text.error} />}
                {text.data && (
                    <>
                        <pre className="max-h-[60dvh] overflow-auto rounded-lg border border-primary-700 bg-primary-950/30 p-4 text-sm wrap-break-word whitespace-pre-wrap text-primary-200">
                            {text.data.text || "No readable text was found in this file."}
                        </pre>
                        {text.data.truncated && (
                            <p className="text-sm text-primary-400">
                                This preview is shortened. Download the original for the
                                complete document.
                            </p>
                        )}
                    </>
                )}
                <ActionGroup>
                    <a
                        href={url}
                        download={file.name}
                        className={buttonStyles({
                            variant: "secondary",
                            fullWidth: true,
                        })}
                    >
                        <Download size={16} aria-hidden="true" />
                        Download
                    </a>
                </ActionGroup>
            </div>
        </Modal>
    );
}
