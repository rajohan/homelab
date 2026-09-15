import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "./Button";
import { IconButton } from "./IconButton";

/**
 * Copy caller-owned text only on an explicit click, with accessible outcome feedback.
 * @param props - The text, accessible action label and optional icon-only presentation.
 * @returns A reusable clipboard action; no text is persisted by this component.
 */
export function CopyTextButton({
    text,
    label,
    iconOnly = false,
}: {
    readonly text: string;
    readonly label: string;
    readonly iconOnly?: boolean;
}) {
    const [outcome, setOutcome] = useState<{ text: string; copied: boolean }>();
    const state =
        outcome?.text === text ? (outcome.copied ? "copied" : "unavailable") : "idle";
    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            setOutcome({ text, copied: true });
        } catch {
            setOutcome({ text, copied: false });
        }
    }
    const feedback = state === "copied" ? "Copied" : "Copy unavailable";
    const accessibleLabel =
        state === "idle" ? label : `${label} (${feedback.toLowerCase()})`;
    const Icon = state === "copied" ? Check : Copy;
    return (
        <>
            {iconOnly ? (
                <IconButton
                    icon={Icon}
                    label={accessibleLabel}
                    onClick={() => void copy()}
                />
            ) : (
                <Button
                    variant="secondary"
                    size="sm"
                    aria-label={accessibleLabel}
                    onClick={() => void copy()}
                >
                    <Icon aria-hidden="true" className="size-4" />
                    {state === "idle" ? "Copy" : feedback}
                </Button>
            )}
            <output className="sr-only">
                {state === "copied" && `${label}: copied.`}
                {state === "unavailable" &&
                    "Copy unavailable. Select the text and copy it manually."}
            </output>
        </>
    );
}
