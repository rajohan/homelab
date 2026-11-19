import { Button } from "@homelab/ui";
import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";

import { BrowserClipboard } from "./BrowserClipboard";

/** Attach native keyboard, touch and pointer input to the current operator control period.
 * @returns An input surface aligned to the framebuffer and the current clipboard controls.
 */
export function BrowserInputLayer({
    accessId,
    epoch,
}: {
    readonly accessId: string;
    readonly epoch: string;
}) {
    const target = useRef<HTMLDivElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<"connecting" | "connected" | "disconnected">(
        "connecting"
    );
    useEffect(() => {
        const element = target.current;
        if (!element) return;
        const url = new URL("/api/mira/browser/display", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("id", accessId);
        url.searchParams.set("epoch", epoch);
        url.searchParams.set("input", "1");
        const input = new RFB(element, url.href);
        input.scaleViewport = true;
        const connected = () => setState("connected");
        const disconnected = () => setState("disconnected");
        const credentials = () => input.disconnect();
        const preserveEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") event.stopPropagation();
        };
        element.addEventListener("keydown", preserveEscape);
        input.addEventListener("connect", connected);
        input.addEventListener("disconnect", disconnected);
        input.addEventListener("credentialsrequired", credentials);
        return () => {
            element.removeEventListener("keydown", preserveEscape);
            input.removeEventListener("connect", connected);
            input.removeEventListener("disconnect", disconnected);
            input.removeEventListener("credentialsrequired", credentials);
            input.disconnect();
        };
    }, [accessId, epoch, attempt]);
    return (
        <>
            <div className="relative col-start-1 row-start-1 overflow-hidden rounded-lg border border-transparent">
                <div
                    role="application"
                    aria-label="Control remote Chromium"
                    ref={target}
                    className="absolute inset-0 opacity-0"
                />
            </div>
            <div className="col-start-1 row-start-2">
                {state === "connecting" && <output>Connecting controls…</output>}
                {state === "disconnected" && (
                    <Button
                        variant="secondary"
                        onClick={() => {
                            setState("connecting");
                            setAttempt((value) => value + 1);
                        }}
                    >
                        Reconnect controls
                    </Button>
                )}
                <BrowserClipboard
                    key={state}
                    accessId={accessId}
                    epoch={epoch}
                    target={target}
                    enabled={state === "connected"}
                />
            </div>
        </>
    );
}
