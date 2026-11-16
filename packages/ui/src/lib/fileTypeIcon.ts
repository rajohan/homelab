import { describeFile } from "@homelab/contracts/files";
import {
    FileCode2,
    FileImage,
    FileJson,
    FileSpreadsheet,
    FileText,
    FileType,
    type LucideIcon,
} from "lucide-react";

/** Stable shared file icons, selected without constructing a component during render. */
export const fileTypeIcons = {
    image: FileImage,
    pdf: FileText,
    markdown: FileType,
    json: FileJson,
    code: FileCode2,
    table: FileSpreadsheet,
    text: FileText,
};

/**
 * Resolve the shared icon for uploads, conversation attachments and generated files.
 * @param file - Display filename and optional verified media type.
 * @returns A stable Lucide component; no component is created during rendering.
 */
export function fileTypeIcon(file: { name: string; mediaType?: string }): LucideIcon {
    return fileTypeIcons[describeFile(file).kind];
}
