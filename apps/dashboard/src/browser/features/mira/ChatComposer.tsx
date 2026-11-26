import type { MiraAttachment } from "@homelab/contracts/mira";
import { Button, IconButton } from "@homelab/ui";
import { SlidersHorizontal, Square } from "lucide-react";
import { useRef } from "react";

import { AttachmentPicker } from "./AttachmentPicker";
import { ChatEmojiPicker } from "./ChatEmojiPicker";
import { ComposerSurface } from "./ComposerSurface";
import { MessageField } from "./MessageField";
import { MiraVoice } from "./MiraVoice";
import { SendMessageButton } from "./SendMessageButton";
import type { MiraVoiceConnection } from "./voiceConnection";

/**
 * Keep drafting, attachments and send/stop actions together at the foot of the chat workspace.
 * @returns An accessible composer using the shared inputs and buttons at every viewport size.
 */
export function ChatComposer({
    voice,
    transcript,
    onSetup,
    text,
    onText,
    attachments,
    onAttachments,
    uploading,
    onUploading,
    sending,
    active = false,
    steerable = false,
    stopping = false,
    stopPending = false,
    onStop,
    onSend,
    onBrowse,
}: {
    readonly voice?: MiraVoiceConnection;
    readonly transcript?: string;
    readonly onSetup?: () => void;
    readonly text: string;
    readonly onText: (value: string) => void;
    readonly attachments: MiraAttachment[];
    readonly onAttachments: (files: MiraAttachment[]) => void;
    readonly uploading: boolean;
    readonly onUploading: (busy: boolean) => void;
    readonly sending: boolean;
    readonly active?: boolean;
    readonly steerable?: boolean;
    readonly stopping?: boolean;
    readonly stopPending?: boolean;
    readonly onStop?: () => void;
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
            className={
                onSetup
                    ? "w-full"
                    : "chat-column max-h-[50%] shrink-0 overflow-y-auto pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-4 [@media(max-height:28rem)]:py-1"
            }
            onSubmit={(event) => {
                event.preventDefault();
                if (canSend) onSend();
            }}
        >
            <ComposerSurface>
                {transcript && (
                    <p
                        className="px-2 text-sm wrap-anywhere text-primary-200"
                        aria-label="Voice transcript"
                        aria-live="polite"
                    >
                        {transcript}
                    </p>
                )}
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
                            {voice && <MiraVoice voice={voice} />}
                            {onSetup && (
                                <IconButton
                                    icon={SlidersHorizontal}
                                    label="Chat settings"
                                    disabled={sending || uploading}
                                    onClick={onSetup}
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
                            <SendMessageButton busy={sending} disabled={!canSend} />
                        </>
                    }
                >
                    <MessageField
                        rows={onSetup ? 2 : 1}
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
            </ComposerSurface>
        </form>
    );
}
