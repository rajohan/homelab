import { LoadingState, Popover } from "@homelab/ui";
import { Smile } from "lucide-react";
import { lazy, type RefObject, Suspense, useState } from "react";

const Picker = lazy(() => import("emoji-picker-react"));

/** Insert a native emoji into the draft at its current selection.
 * @returns An anchored picker shared by web and Windows chat.
 */
export function ChatEmojiPicker({
    field,
    onText,
    disabled,
}: {
    readonly field: RefObject<HTMLTextAreaElement | null>;
    readonly onText: (value: string) => void;
    readonly disabled: boolean;
}) {
    const [tooLong, setTooLong] = useState(false);
    return (
        <Popover
            label="Insert emoji"
            trigger={<Smile size={18} aria-hidden="true" />}
            anchor="top start"
            disabled={disabled}
            panelClassName="w-[min(22rem,calc(100vw-1rem))] p-0 sm:p-0"
        >
            {({ close }) => (
                <Suspense fallback={<LoadingState label="Loading emojis…" />}>
                    <Picker
                        width="100%"
                        height="min(24rem, 48dvh)"
                        colorScheme="dark"
                        emojiStyle="native"
                        previewConfig={{ showPreview: false }}
                        autoFocusSearch={globalThis.matchMedia("(pointer: fine)").matches}
                        onEmojiClick={({ emoji }) => {
                            const input = field.current;
                            if (!input || input.disabled) return;
                            if (
                                input.value.length -
                                    (input.selectionEnd - input.selectionStart) +
                                    emoji.length >
                                input.maxLength
                            ) {
                                setTooLong(true);
                                return;
                            }
                            setTooLong(false);
                            input.setRangeText(
                                emoji,
                                input.selectionStart,
                                input.selectionEnd,
                                "end"
                            );
                            onText(input.value);
                            close();
                            input.focus({ preventScroll: true });
                        }}
                    />
                    {tooLong && (
                        <output className="px-3 py-2 text-sm text-primary-100">
                            This emoji exceeds the message length limit.
                        </output>
                    )}
                </Suspense>
            )}
        </Popover>
    );
}
