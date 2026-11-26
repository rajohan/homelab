import {
    browserClipboardCommandSchema,
    browserClipboardResultSchema,
} from "@homelab/contracts/miraBrowserClipboard";
import { ActionGroup, Button, FormField, Textarea } from "@homelab/ui";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as v from "valibot";

type Command = v.InferOutput<typeof browserClipboardCommandSchema>;

export interface BrowserClipboardControls {
    readonly copy: () => void;
    readonly paste: () => void;
}

/** Connect operator copy/paste gestures to the current browser controller generation.
 * @returns Clipboard controls and a plain-text fallback when local clipboard permission is unavailable.
 */
export function BrowserClipboard({
    target,
    accessId,
    epoch,
    onControlsChange,
}: {
    readonly target: RefObject<HTMLDivElement | null>;
    readonly accessId: string;
    readonly epoch: string;
    readonly onControlsChange: (controls: BrowserClipboardControls | null) => void;
}) {
    const sendText = useRef<((text: string) => void) | null>(null);
    const field = useRef<HTMLTextAreaElement>(null);
    const [message, setMessage] = useState("");
    const [fallback, setFallback] = useState<"copy" | "paste" | "error" | null>(null);
    const [text, setText] = useState("");
    useEffect(() => {
        field.current?.focus({ preventScroll: true });
        if (field.current?.readOnly) field.current.select();
    }, [fallback]);
    useEffect(() => {
        const element = target.current;
        if (!element) return;
        const lifetime = new AbortController();
        let awaitingPaste: ReturnType<typeof setTimeout> | undefined;
        let busy = false;
        const transfer = async (command: Command) => {
            lifetime.signal.throwIfAborted();
            const payload = v.parse(browserClipboardCommandSchema, command);
            const url = new URL("/api/mira/browser/clipboard", location.href);
            url.searchParams.set("id", accessId);
            url.searchParams.set("epoch", epoch);
            const response = await fetch(url, {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: lifetime.signal,
            });
            const result = v.parse(browserClipboardResultSchema, await response.json());
            lifetime.signal.throwIfAborted();
            if (!response.ok || !result.ok)
                throw new Error("Clipboard transfer did not finish.");
            return result.text;
        };
        const perform = async (operation: () => Promise<void>) => {
            if (lifetime.signal.aborted || busy) return;
            busy = true;
            try {
                await operation();
            } catch {
                if (!lifetime.signal.aborted) {
                    setText("");
                    setFallback("error");
                    setMessage(
                        "Clipboard transfer did not finish. Check the browser before trying again. Text is limited to 8,192 characters."
                    );
                }
            } finally {
                busy = false;
            }
        };
        const send = async (value: string) => {
            await transfer({ kind: "paste", text: value });
            if (lifetime.signal.aborted) return;
            setFallback(null);
            setText("");
            setMessage("Pasted into browser.");
            element.querySelector("canvas")?.focus({ preventScroll: true });
        };
        const copy = async (kind: "copy" | "read") => {
            const result = transfer({ kind });
            try {
                if (
                    typeof navigator.clipboard?.write === "function" &&
                    typeof ClipboardItem !== "undefined"
                ) {
                    // Keep the write in the original gesture. A browser may deny permission
                    // before it ever consumes the promised ClipboardItem.
                    const data = result.then(
                        (value) => new Blob([value], { type: "text/plain" })
                    );
                    void data.catch(() => {});
                    await navigator.clipboard.write([
                        new ClipboardItem({ "text/plain": data }),
                    ]);
                } else {
                    const value = await result;
                    lifetime.signal.throwIfAborted();
                    await navigator.clipboard.writeText(value);
                }
                if (lifetime.signal.aborted) return;
                setMessage("Copied to your clipboard.");
                setFallback(null);
                setText("");
            } catch {
                const value = await result;
                if (lifetime.signal.aborted) return;
                setText(value);
                setFallback("copy");
                setMessage("Copy the selected text to your clipboard.");
            }
        };
        const offerPaste = () => {
            if (!lifetime.signal.aborted) {
                setText("");
                setFallback("paste");
                setMessage("Paste plain text to send it to the remote browser.");
            }
        };
        const paste = async () => {
            let value;
            try {
                value = await navigator.clipboard.readText();
            } catch {
                offerPaste();
                return;
            }
            if (value) await send(value);
            else offerPaste();
        };
        const key = (event: KeyboardEvent) => {
            if (!event.isTrusted || (!event.ctrlKey && !event.metaKey) || event.altKey)
                return;
            const name = event.key.toLowerCase();
            if (name === "c" && !event.shiftKey) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!event.repeat) void perform(() => copy("copy"));
            }
            if (name === "v") {
                // Let the local browser emit its native paste event; noVNC must not consume it.
                event.stopImmediatePropagation();
                if (event.repeat) {
                    event.preventDefault();
                    return;
                }
                // Some browsers do not dispatch paste on a canvas. Only offer manual entry if
                // this specific paste gesture never produced clipboard text.
                clearTimeout(awaitingPaste);
                awaitingPaste = setTimeout(() => {
                    if (!busy && element.contains(document.activeElement)) offerPaste();
                }, 1000);
            }
        };
        const pasted = (event: ClipboardEvent) => {
            if (!event.isTrusted) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            clearTimeout(awaitingPaste);
            const value = event.clipboardData?.getData("text/plain");
            if (value) void perform(() => send(value));
            else offerPaste();
        };
        element.addEventListener("keydown", key, true);
        element.addEventListener("paste", pasted, true);
        sendText.current = (value) => void perform(() => send(value));
        onControlsChange({
            copy: () => void perform(() => copy("read")),
            paste: () => void perform(paste),
        });
        return () => {
            clearTimeout(awaitingPaste);
            sendText.current = null;
            lifetime.abort();
            onControlsChange(null);
            element.removeEventListener("keydown", key, true);
            element.removeEventListener("paste", pasted, true);
        };
    }, [target, accessId, epoch, onControlsChange]);
    if (!fallback) return <output className="sr-only">{message}</output>;
    const close = () => {
        setFallback(null);
        setText("");
        setMessage("");
        target.current?.querySelector("canvas")?.focus({ preventScroll: true });
    };
    return (
        <section
            aria-label="Browser clipboard"
            className="pointer-events-auto absolute inset-x-2 bottom-2 mx-auto max-h-full max-w-sm space-y-3 overflow-y-auto rounded-lg border border-primary-700 bg-surface-panel p-3 shadow-xl shadow-black/40"
        >
            <output className="block text-sm text-primary-200">{message}</output>
            {fallback !== "error" && (
                <FormField label="Clipboard text">
                    <Textarea
                        ref={field}
                        maxLength={8192}
                        value={text}
                        readOnly={fallback === "copy"}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.stopPropagation();
                                close();
                            }
                        }}
                    />
                </FormField>
            )}
            <ActionGroup>
                <Button size="sm" variant="secondary" onClick={close}>
                    Close
                </Button>
                {fallback === "paste" && (
                    <Button
                        size="sm"
                        disabled={!text}
                        onClick={() => sendText.current?.(text)}
                    >
                        Paste into browser
                    </Button>
                )}
            </ActionGroup>
        </section>
    );
}
