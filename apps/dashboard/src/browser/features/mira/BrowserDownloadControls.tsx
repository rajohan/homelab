import { miraBrowserDownloadNameSchema } from "@homelab/contracts/miraBrowser";
import {
    ActionGroup,
    Button,
    ErrorNotice,
    FormField,
    Input,
    LoadingState,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useRef, useState } from "react";
import * as v from "valibot";

import { api } from "../../api/client";
import { AttachmentFileActions } from "./AttachmentFileActions";
import type { BrowserFileCommand, BrowserFileTarget } from "./BrowserFileDialog";

/** Confirm a specific download and expose local preview/save only after its verified attachment exists.
 * @returns File naming, explicit confirmation, and the actual downloaded file's actions.
 */
export function BrowserDownloadControls({
    target,
    suggestedName,
    disabled,
    now,
    onCommand,
    onSubmitted,
    onClose,
}: {
    readonly target: BrowserFileTarget | null;
    readonly suggestedName: string;
    readonly disabled: boolean;
    readonly now: number;
    readonly onCommand: BrowserFileCommand;
    readonly onSubmitted: (origin: string) => void;
    readonly onClose: () => void;
}) {
    const [name, setName] = useState(() =>
        v.safeParse(miraBrowserDownloadNameSchema, suggestedName).success
            ? suggestedName
            : ""
    );
    const [receipt, setReceipt] = useState<{
        id: string;
        name: string;
        at: number;
    } | null>(null);
    const [notice, setNotice] = useState("");
    const submitting = useRef(false);
    const parsed = v.safeParse(miraBrowserDownloadNameSchema, name);
    const timedOut = receipt && now - receipt.at >= 60_000;
    const files = useQuery({
        queryKey: ["operations", "mira", "browser-download-file", receipt?.id],
        queryFn: ({ signal }) => api.mira.files.metadata.query([receipt!.id], { signal }),
        enabled: Boolean(receipt),
        retry: false,
        gcTime: 0,
        refetchInterval: (query) =>
            query.state.data?.length || timedOut || query.state.error ? false : 1200,
    });
    if (receipt) {
        const file = files.data?.find(
            (row) => row.id === receipt.id && row.name === receipt.name
        );
        return (
            <div className="space-y-4">
                {file && (
                    <>
                        <p className="text-sm wrap-anywhere text-primary-200">
                            {file.name} was saved in this chat.
                        </p>
                        <AttachmentFileActions file={file} />
                    </>
                )}
                {!file && files.error && <ErrorNotice error={files.error} />}
                {!file && !files.error && timedOut && (
                    <p className="text-sm text-primary-300">
                        This file has not appeared in the chat. Check its status before
                        requesting another download.
                    </p>
                )}
                {!file && !files.error && !timedOut && (
                    <LoadingState label={`Waiting for ${receipt.name}…`} />
                )}
                <ActionGroup>
                    <Button variant="secondary" onClick={onClose}>
                        Close
                    </Button>
                    {!file && (timedOut || files.error) && (
                        <Button
                            busy={files.isFetching}
                            onClick={() => void files.refetch()}
                        >
                            Check file status
                        </Button>
                    )}
                </ActionGroup>
            </div>
        );
    }
    return (
        <form
            className="space-y-4"
            onSubmit={(event) => {
                event.preventDefault();
                if (!target || disabled || !parsed.success || submitting.current) return;
                submitting.current = true;
                const commandId = onCommand({
                    method: "download",
                    input: { observationId: target.observationId, ref: target.ref },
                    origin: target.origin,
                    name: parsed.output,
                });
                if (commandId) {
                    setReceipt({ id: commandId, name: parsed.output, at: Date.now() });
                    onSubmitted(target.origin);
                } else {
                    submitting.current = false;
                    setNotice("The browser is busy. Check the page before saving.");
                }
            }}
        >
            <FormField
                label="File name"
                description="PNG, JPEG, WebP, PDF or UTF-8 text, up to 25 MiB."
            >
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={200}
                    placeholder="document.pdf"
                    required
                />
            </FormField>
            <p className="text-sm leading-relaxed text-primary-400">
                Save the file in this chat to make it available to Mira. You can then
                preview it or download a copy to your device.
            </p>
            {notice && (
                <output className="block text-sm text-primary-300">{notice}</output>
            )}
            <ActionGroup>
                <Button variant="secondary" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!target || disabled || !parsed.success}>
                    <Download size={16} aria-hidden="true" />
                    Save to chat
                </Button>
            </ActionGroup>
        </form>
    );
}
