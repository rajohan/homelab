import type { MiraAttachment } from "@homelab/contracts/mira";
import { Button } from "@homelab/ui";
import { ArrowUp, Square } from "lucide-react";
import { useRef } from "react";

import { AttachmentPicker } from "./AttachmentPicker";
import { ChatEmojiPicker } from "./ChatEmojiPicker";
import { MessageField } from "./MessageField";
import { MiraVoice } from "./MiraVoice";
import type { MiraVoiceConnection } from "./voiceConnection";
import { VoiceStatus } from "./VoiceStatus";

/**
 * Keep drafting, attachments and send/stop actions together at the foot of the chat workspace.
 * @returns An accessible composer using the shared inputs and buttons at every viewport size.
 */
export function ChatComposer({
    voice,
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
}: {
    readonly voice: MiraVoiceConnection;
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
}) {
    const field = useRef<HTMLTextAreaElement>(null);
    const placeholder = active ? "Add guidance while Mira works…" : "Message Mira…";
    // Cancellation remains part of a terminal run's history, not a composer lock.
    const blocked = active && (stopping || stopPending || !steerable);
    const canSend = Boolean(text.trim()) && !blocked && !uploading && !sending;
    return (
        <form
            className="mx-auto max-h-[50dvh] w-full max-w-3xl shrink-0 overflow-y-auto px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4 [@media(max-height:28rem)]:py-1"
            onSubmit={(event) => {
                event.preventDefault();
                if (canSend) onSend();
            }}
        >
            <VoiceStatus voice={voice} />
            <div className="rounded-2xl border border-primary-600 bg-surface-card p-2 focus-within:border-accent-400">
                <AttachmentPicker
                    compact
                    value={attachments}
                    onChange={onAttachments}
                    onBusyChange={onUploading}
                    onBrowse={onBrowse}
                    disabled={sending || blocked}
                    controls={
                        <>
                            <ChatEmojiPicker
                                field={field}
                                onText={onText}
                                disabled={sending}
                            />
                            <MiraVoice voice={voice} />
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
                                <ArrowUp size={18} aria-hidden="true" />
                                Send
                            </Button>
                        </>
                    }
                >
                    <MessageField
                        field={field}
                        value={text}
                        onChange={onText}
                        canSend={canSend}
                        disabled={sending}
                        placeholder={
                            blocked
                                ? "Draft a message for when this run finishes…"
                                : placeholder
                        }
                    />
                </AttachmentPicker>
            </div>
        </form>
    );
}
