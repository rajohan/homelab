import {
    browserClipboardCommandSchema,
    browserClipboardResultSchema,
} from "@homelab/contracts/miraBrowserClipboard";
import { Button } from "@homelab/ui";
import { ClipboardPaste, Copy } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import * as v from "valibot";

type Command = v.InferOutput<typeof browserClipboardCommandSchema>;

/** Connect operator copy/paste gestures to the current browser controller generation.
 * @returns Clipboard controls and a plain-text fallback when local clipboard permission is unavailable.
 */
export function BrowserClipboard({
    target,
    accessId,
    epoch,
    enabled,
}: {
    readonly target: RefObject<HTMLDivElement | null>;
    readonly accessId: string;
    readonly epoch: string;
    readonly enabled: boolean;
}) {
    const actions = useRef<{
        copy: () => void;
        paste: () => void;
        send: (text: string) => void;
    } | null>(null);
    const [message, setMessage] = useState("");
    const [fallback, setFallback] = useState<"copy" | "paste" | null>(null);
    const [text, setText] = useState("");
    useEffect(() => {
        const element = target.current;
        if (!enabled || !element) return;
        const lifetime = new AbortController();
        let busy = false;
        const transfer = async (command: Command) => {
            if (busy) throw new Error("A clipboard transfer is still running.");
            busy = true;
            try {
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
                const result = v.parse(
                    browserClipboardResultSchema,
                    await response.json()
                );
                lifetime.signal.throwIfAborted();
                if (!response.ok || !result.ok)
                    throw new Error("Clipboard transfer did not finish.");
                return result.text;
            } finally {
                busy = false;
            }
        };
        const failed = () => {
            if (!lifetime.signal.aborted)
                setMessage(
                    "Clipboard transfer did not finish. Check the browser before trying again. Text is limited to 8,192 characters."
                );
        };
        const send = (value: string) => {
            void transfer({ kind: "paste", text: value }).then(() => {
                setFallback(null);
                setText("");
                setMessage("Pasted into browser.");
                element.querySelector("canvas")?.focus();
                return;
            }, failed);
        };
        const copy = (kind: "copy" | "read") => {
            let copied: string | undefined;
            const result = transfer({ kind }).then((value) => {
                copied = value;
                return value;
            });
            // Construct the ClipboardItem during the gesture, before awaiting the server.
            const written =
                typeof navigator.clipboard?.write === "function" &&
                typeof ClipboardItem !== "undefined"
                    ? navigator.clipboard.write([
                          new ClipboardItem({
                              "text/plain": result.then(
                                  (value) => new Blob([value], { type: "text/plain" })
                              ),
                          }),
                      ])
                    : result.then((value) => navigator.clipboard.writeText(value));
            void written
                .then(() => {
                    if (!lifetime.signal.aborted) {
                        setMessage("Copied to your clipboard.");
                        setFallback(null);
                        setText("");
                    }
                    return;
                })
                .catch(async () => {
                    try {
                        await result;
                    } catch {
                        failed();
                        return;
                    }
                    if (!lifetime.signal.aborted && copied !== undefined) {
                        setText(copied);
                        setFallback("copy");
                        setMessage("Select and copy the text below.");
                    }
                });
        };
        const paste = () => {
            void (
                navigator.clipboard?.readText?.() ??
                Promise.reject(new Error("Clipboard unavailable."))
            )
                .then((value) => {
                    if (!lifetime.signal.aborted) send(value);
                    return;
                })
                .catch(() => {
                    if (!lifetime.signal.aborted) {
                        setText("");
                        setFallback("paste");
                        setMessage("Paste your text below, then send it to the browser.");
                    }
                });
        };
        const key = (event: KeyboardEvent) => {
            if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;
            const name = event.key.toLowerCase();
            if (name === "c") {
                event.preventDefault();
                event.stopImmediatePropagation();
                copy("copy");
            }
            if (name === "v") {
                // Let the local browser emit its native paste event; noVNC must not consume it.
                event.stopImmediatePropagation();
            }
        };
        const pasted = (event: ClipboardEvent) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            const value = event.clipboardData?.getData("text/plain");
            if (value !== undefined) send(value);
        };
        element.addEventListener("keydown", key, true);
        element.addEventListener("paste", pasted, true);
        actions.current = { copy: () => copy("read"), paste, send };
        return () => {
            actions.current = null;
            lifetime.abort();
            element.removeEventListener("keydown", key, true);
            element.removeEventListener("paste", pasted, true);
        };
    }, [target, accessId, epoch, enabled]);
    if (!enabled) return null;
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => actions.current?.copy()}>
                    <Copy size={14} aria-hidden="true" /> Copy from browser
                </Button>
                <Button variant="ghost" onClick={() => actions.current?.paste()}>
                    <ClipboardPaste size={14} aria-hidden="true" /> Paste into browser
                </Button>
            </div>
            {message && (
                <output className="block text-sm text-primary-300">{message}</output>
            )}
            {fallback && (
                <div className="space-y-2">
                    <label className="block text-sm text-primary-200">
                        Clipboard text
                        <textarea
                            className="mt-1 min-h-24 w-full rounded-lg border border-primary-600 bg-primary-950 p-3 text-primary-100"
                            maxLength={8192}
                            value={text}
                            readOnly={fallback === "copy"}
                            onChange={(event) => setText(event.target.value)}
                            onFocus={(event) => {
                                if (fallback === "copy") event.target.select();
                            }}
                        />
                    </label>
                    {fallback === "paste" && (
                        <Button
                            variant="secondary"
                            onClick={() => actions.current?.send(text)}
                        >
                            Paste into browser
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        onClick={() => {
                            setFallback(null);
                            setText("");
                            setMessage("");
                        }}
                    >
                        Close clipboard
                    </Button>
                </div>
            )}
        </div>
    );
}
