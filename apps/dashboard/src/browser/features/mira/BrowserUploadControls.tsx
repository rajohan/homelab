import type { MiraBrowserUploadFile } from "@homelab/contracts/miraBrowser";
import {
    ActionGroup,
    Button,
    ChoiceBar,
    ErrorNotice,
    FileDropZone,
    FormField,
    Select,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { FileUp, Upload } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import type { BrowserFileCommand, BrowserFileTarget } from "./BrowserFileDialog";
import { chatAttachmentAccept, uploadChatAttachment } from "./uploadChatAttachment";

/** Choose a chat attachment or local file and confirm the specific site's access to it.
 * @returns One confirmation that pins the file digest, page observation and target.
 */
export function BrowserUploadControls({
    accessId,
    epoch,
    target,
    disabled,
    now,
    onCommand,
    onClose,
}: {
    readonly accessId: string;
    readonly epoch: string;
    readonly target: BrowserFileTarget | null;
    readonly disabled: boolean;
    readonly now: number;
    readonly onCommand: BrowserFileCommand;
    readonly onClose: () => void;
}) {
    const [source, setSource] = useState<"device" | "chat">("device");
    const [local, setLocal] = useState<{ file: File; id: string } | null>(null);
    const [chosen, setChosen] = useState<MiraBrowserUploadFile | null>(null);
    const [notice, setNotice] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const busy = useRef(false);
    const session = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        session.current = controller;
        return () => controller.abort();
    }, []);
    const current = useRef({ target, disabled, onCommand, onClose });
    useLayoutEffect(() => {
        current.current = { target, disabled, onCommand, onClose };
    }, [target, disabled, onCommand, onClose]);
    const files = useQuery({
        queryKey: ["operations", "mira", "browser-uploads", accessId, epoch],
        queryFn: ({ signal }) =>
            api.mira.browser.uploads.query({ id: accessId }, { signal }),
        enabled: source === "chat",
        refetchInterval: 5000,
        retry: false,
        gcTime: 0,
    });
    const available = files.data?.find(
        (row) =>
            row.id === chosen?.id &&
            row.sha256 === chosen.sha256 &&
            row.name === chosen.name &&
            row.size === chosen.size
    );
    const chatFile =
        !files.error && now - files.dataUpdatedAt < 10_000 ? available : undefined;
    const stage = useOperation(async (selected: { id: string; file: File }, signal) => {
        const combined = AbortSignal.any([signal, session.current!.signal]);
        const attached = await uploadChatAttachment(selected.file, selected.id, combined);
        return api.mira.browser.attach.mutate(
            { id: accessId, epoch, fileId: attached.id },
            { signal: combined }
        );
    });
    function choose(list: File[]) {
        if (busy.current || list.length === 0) return;
        setNotice("");
        const file = list[0]!;
        if (list.length !== 1 || file.size === 0 || file.size > 26_214_400) {
            setLocal(null);
            setNotice("Choose one file between 1 byte and 25 MiB.");
            return;
        }
        setLocal({ file, id: crypto.randomUUID() });
    }
    async function confirm() {
        if (!target || disabled || busy.current) return;
        busy.current = true;
        setNotice("");
        try {
            const file =
                source === "device" && local ? await stage.mutateAsync(local) : chatFile;
            if (!file || session.current?.signal.aborted) return;
            const latest = current.current;
            if (
                latest.disabled ||
                !latest.target ||
                target.observationId !== latest.target.observationId ||
                target.ref !== latest.target.ref ||
                target.origin !== latest.target.origin
            ) {
                setNotice(
                    "The page changed. Review its current file input before sending."
                );
                return;
            }
            const commandId = latest.onCommand({
                method: "upload",
                origin: target.origin,
                input: { observationId: target.observationId, ref: target.ref },
                file,
            });
            if (commandId) latest.onClose();
            else setNotice("The browser is busy. Check the page before sending.");
        } catch {
            // useOperation presents the server error; uncertain commands are never replayed.
        } finally {
            busy.current = false;
        }
    }
    return (
        <div className="space-y-4">
            <fieldset disabled={stage.isPending} className="min-w-0 space-y-3">
                <ChoiceBar
                    label="File source"
                    value={source}
                    options={[
                        { value: "device", label: "This device" },
                        { value: "chat", label: "Chat attachments" },
                    ]}
                    onChange={(next) => {
                        setNotice("");
                        setSource(next);
                    }}
                />
                {source === "device" ? (
                    <FileDropZone
                        disabled={stage.isPending}
                        onFiles={choose}
                        className="space-y-2"
                    >
                        <input
                            aria-label="Local file to upload"
                            type="file"
                            accept={chatAttachmentAccept}
                            className="hidden"
                            ref={input}
                            onChange={(event) => {
                                choose([...(event.target.files ?? [])]);
                                event.target.value = "";
                            }}
                        />
                        <Button
                            variant="secondary"
                            onClick={() => input.current?.click()}
                        >
                            <FileUp size={16} aria-hidden="true" />
                            {local ? "Change file" : "Choose file"}
                        </Button>
                        {local && (
                            <p className="text-sm wrap-anywhere text-primary-200">
                                {local.file.name} ·{" "}
                                {local.file.size.toLocaleString("en-US")} bytes
                            </p>
                        )}
                    </FileDropZone>
                ) : (
                    <FormField label="Chat attachment">
                        <Select
                            label="Chat attachment"
                            value={available?.id ?? ""}
                            disabled={files.isPending || Boolean(files.error)}
                            options={[
                                {
                                    value: "",
                                    label:
                                        files.data?.length === 0
                                            ? "No attachments in this chat"
                                            : "Choose an attachment",
                                },
                                ...(files.data ?? []).map((row) => ({
                                    value: row.id,
                                    label: `${row.name} · ${row.size.toLocaleString("en-US")} bytes`,
                                })),
                            ]}
                            onChange={(id) =>
                                setChosen(
                                    files.data?.find((row) => row.id === id) ?? null
                                )
                            }
                        />
                        {files.error && <ErrorNotice error={files.error} />}
                    </FormField>
                )}
            </fieldset>
            <p className="text-sm leading-relaxed text-primary-400">
                {source === "device" && "The file will also be saved in this chat. "}
                The website can read it as soon as you send it.
            </p>
            {notice && (
                <output className="block text-sm text-primary-300">{notice}</output>
            )}
            {stage.error && <ErrorNotice error={stage.error} />}
            <ActionGroup>
                <Button variant="secondary" onClick={onClose}>
                    Cancel
                </Button>
                <Button
                    onClick={() => void confirm()}
                    busy={stage.isPending}
                    disabled={
                        !target || disabled || !(source === "device" ? local : chatFile)
                    }
                >
                    <Upload size={16} aria-hidden="true" />
                    Send to website
                </Button>
            </ActionGroup>
        </div>
    );
}
