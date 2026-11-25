import * as v from "valibot";

export const chatAttachmentAccept =
    "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,application/json,.txt,.json,.csv,.md,.yaml,.yml,.ts,.tsx,.js,.py,.sh,.log";

const uploaded = v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.string(),
    mediaType: v.string(),
    bytes: v.number(),
    createdAt: v.string(),
});

/** Store a selected local file using the dashboard's authenticated chat file endpoint.
 * @param file - File selected by the operator.
 * @param id - Stable upload identity reused if a request must be verified again.
 * @param signal - Cancels an upload when the UI or account session closes.
 * @returns The owned file metadata after the file has passed server validation.
 */
export async function uploadChatAttachment(file: File, id: string, signal: AbortSignal) {
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
    const attachment = v.parse(uploaded, await response.json());
    if (
        attachment.id !== id ||
        attachment.name !== file.name ||
        attachment.bytes !== file.size
    )
        throw new Error("The uploaded file could not be verified.");
    return attachment;
}
