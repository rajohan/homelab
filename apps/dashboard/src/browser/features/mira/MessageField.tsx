import { Textarea } from "@homelab/ui";
import type { Ref } from "react";

/** Edit a Mira message with the same length, keyboard and input-method rules on the landing and in chat.
 * @returns The labelled message field, which submits its containing form on desktop Enter.
 */
export function MessageField({
    field,
    value,
    onChange,
    placeholder = "Message Mira…",
    disabled,
    canSend,
    rows = 1,
}: {
    readonly field?: Ref<HTMLTextAreaElement>;
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly placeholder?: string;
    readonly canSend: boolean;
    readonly disabled: boolean;
    readonly rows?: number;
}) {
    return (
        <Textarea
            ref={field}
            aria-label="Message Mira"
            rows={rows}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            maxLength={32_000}
            disabled={disabled}
            placeholder={placeholder}
            className="field-sizing-content max-h-[min(28dvh,18rem)] min-h-11 resize-none border-0 bg-transparent p-2 text-base shadow-none data-focus:ring-0 [@media(max-height:28rem)]:min-h-9"
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
                    event.currentTarget.form?.requestSubmit();
                }
            }}
        />
    );
}
