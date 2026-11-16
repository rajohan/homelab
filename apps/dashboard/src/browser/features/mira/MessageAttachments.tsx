import type { MiraAttachment } from "@homelab/contracts/mira";
import { Button, ErrorNotice, fileTypeIcon } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { AttachmentPreview } from "./AttachmentPreview";

/**
 * Resolve message attachment names without revealing deleted or foreign files.
 * @returns Preview actions for owned files and an honest unavailable-file indicator.
 */
export function MessageAttachments({ ids }: { readonly ids: string[] }) {
    const [visible, setVisible] = useState(8);
    const [selected, setSelected] = useState<MiraAttachment>();
    const files = useQuery({
        queryKey: ["operations", "mira", "message-files", ids],
        queryFn: () => api.mira.files.metadata.query(ids),
    });
    return (
        <div className="mt-3 space-y-2">
            {files.error && <ErrorNotice error={files.error} />}
            <div className="flex flex-wrap gap-2">
                {files.data?.slice(0, visible).map((file) => {
                    const Icon = fileTypeIcon(file);
                    return (
                        <Button
                            key={file.id}
                            variant="secondary"
                            size="sm"
                            aria-label={`Preview ${file.name}`}
                            onClick={() => setSelected(file)}
                        >
                            <Icon size={14} aria-hidden="true" />
                            <span className="max-w-48 truncate">{file.name}</span>
                        </Button>
                    );
                })}
            </div>
            {files.data && files.data.length > visible && (
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setVisible((count) => count + 8)}
                >
                    Show more files ({files.data.length - visible})
                </Button>
            )}
            {files.data && files.data.length < ids.length && (
                <p className="text-xs text-primary-400">
                    Some attachments are no longer available.
                </p>
            )}
            {selected && (
                <AttachmentPreview
                    file={selected}
                    onClose={() => setSelected(undefined)}
                />
            )}
        </div>
    );
}
