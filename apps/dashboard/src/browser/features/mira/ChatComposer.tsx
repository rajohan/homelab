import type { MiraAttachment } from "@homelab/contracts/mira";
import { Button, IconButton, Textarea } from "@homelab/ui";
import { Globe, Monitor, Send, Settings2, Square } from "lucide-react";

import { AttachmentPicker } from "./AttachmentPicker";

/**
 * Keep drafting, attachments and send/stop actions together at the foot of the chat workspace.
 * @returns An accessible composer using the shared inputs and buttons at every viewport size.
 */
export function ChatComposer({
    text,
    onText,
    attachments,
    onAttachments,
    uploading,
    onUploading,
    sending,
    active,
    steerable = false,
    stopping,
    stopPending,
    onStop,
    onSend,
    onBrowse,
    onSettings,
    onComputer,
    onBrowser,
}: {
    readonly text: string;
    readonly onText: (value: string) => void;
    readonly attachments: MiraAttachment[];
    readonly onAttachments: (files: MiraAttachment[]) => void;
    readonly uploading: boolean;
    readonly onUploading: (busy: boolean) => void;
    readonly sending: boolean;
    readonly active: boolean;
    readonly steerable?: boolean;
    readonly stopping: boolean;
    readonly stopPending: boolean;
    readonly onStop: () => void;
    readonly onSend: () => void;
    readonly onBrowse: () => void;
    readonly onBrowser?: (() => void) | undefined;
    readonly onComputer?: (() => void) | undefined;
    readonly onSettings?: (() => void) | undefined;
}) {
    const placeholder = active ? "Add guidance while Mira works…" : "Message Mira…";
    const blocked = stopping || stopPending || (active && !steerable);
    const canSend = Boolean(text.trim()) && !blocked && !uploading && !sending;
    return (
        <form
            className="shrink-0 border-t border-primary-700 p-3 sm:p-4"
            onSubmit={(event) => {
                event.preventDefault();
                if (canSend) onSend();
            }}
        >
            <div className="rounded-xl border border-primary-600 bg-primary-950 p-2 focus-within:border-accent-400">
                <AttachmentPicker
                    compact
                    value={attachments}
                    onChange={onAttachments}
                    onBusyChange={onUploading}
                    onBrowse={onBrowse}
                    disabled={sending || blocked}
                    controls={
                        <>
                            {onBrowser && (
                                <IconButton
                                    icon={Globe}
                                    label="Browser access"
                                    onClick={onBrowser}
                                />
                            )}
                            {onComputer && (
                                <IconButton
                                    icon={Monitor}
                                    label="Computer access"
                                    onClick={onComputer}
                                />
                            )}
                            {onSettings && (
                                <IconButton
                                    icon={Settings2}
                                    label="Chat settings"
                                    disabled={sending || active}
                                    onClick={onSettings}
                                />
                            )}
                        </>
                    }
                    actions={
                        <>
                            {active && (
                                <Button
                                    variant="secondary"
                                    busy={stopPending}
                                    disabled={stopping}
                                    onClick={onStop}
                                >
                                    <Square size={16} aria-hidden="true" />
                                    {stopping ? "Stopping" : "Stop"}
                                </Button>
                            )}
                            <Button type="submit" busy={sending} disabled={!canSend}>
                                <Send size={16} aria-hidden="true" />
                                Send
                            </Button>
                        </>
                    }
                >
                    <Textarea
                        aria-label="Message Mira"
                        rows={4}
                        value={text}
                        onChange={(event) => onText(event.target.value)}
                        maxLength={32_000}
                        disabled={sending}
                        placeholder={
                            blocked
                                ? "Draft a message for when this run finishes…"
                                : placeholder
                        }
                        className="field-sizing-content max-h-[min(28dvh,18rem)] min-h-[clamp(5rem,15dvh,8rem)] resize-none border-0 bg-transparent p-2 shadow-none data-focus:ring-0"
                        onKeyDown={(event) => {
                            if (
                                event.key === "Enter" &&
                                !event.shiftKey &&
                                !event.altKey &&
                                globalThis.matchMedia("(pointer: fine)").matches &&
                                !event.nativeEvent.isComposing &&
                                canSend
                            ) {
                                event.preventDefault();
                                onSend();
                            }
                        }}
                    />
                </AttachmentPicker>
            </div>
        </form>
    );
}
