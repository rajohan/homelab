import { describeFile } from "@homelab/contracts/files";
import type { MiraAttachment } from "@homelab/contracts/mira";
import { ActionGroup, Button, buttonStyles, fileTypeIcons } from "@homelab/ui";
import { Download } from "lucide-react";
import { useState } from "react";

import { AttachmentPreview } from "./AttachmentPreview";

/**
 * Preview or download the exact immutable file described by an approval snapshot.
 * @returns Shared file actions without fetching metadata until the operator opens a preview.
 */
export function AttachmentFileActions({
    file,
}: {
    readonly file: Pick<MiraAttachment, "id" | "name" | "mediaType" | "bytes">;
}) {
    const [open, setOpen] = useState(false);
    const Icon = fileTypeIcons[describeFile(file).kind];
    return (
        <>
            <ActionGroup>
                <Button
                    variant="secondary"
                    aria-label={`Preview ${file.name}`}
                    onClick={() => setOpen(true)}
                >
                    <Icon size={16} aria-hidden="true" />
                    Preview
                </Button>
                <a
                    href={`/api/mira/files/${file.id}`}
                    download={file.name}
                    className={buttonStyles({ variant: "secondary" })}
                >
                    <Download size={16} aria-hidden="true" />
                    Download
                </a>
            </ActionGroup>
            {open && <AttachmentPreview file={file} onClose={() => setOpen(false)} />}
        </>
    );
}
