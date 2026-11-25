import { Button } from "@homelab/ui";
import RFB from "@novnc/novnc";
import { RefreshCw } from "lucide-react";
import { useEffect, useImperativeHandle, useReducer, useRef, useState } from "react";

import type { BrowserClipboardControls } from "./BrowserClipboard";
import { BrowserInputLayer } from "./BrowserInputLayer";

const viewScales = [1, 1.25, 1.5, 2, 3] as const;
function nextZoom(level: number, action: "in" | "out" | "fit") {
    if (action === "fit") return 0;
    return Math.max(
        0,
        Math.min(level + (action === "in" ? 1 : -1), viewScales.length - 1)
    );
}

export interface BrowserViewControls {
    readonly zoomIn: (() => void) | null;
    readonly zoomOut: (() => void) | null;
    readonly fit: (() => void) | null;
    readonly copy: (() => void) | null;
    readonly paste: (() => void) | null;
}

/** Display the current Chromium window and route direct input only during operator control.
 * @returns A live, keyboard-focusable browser viewport with explicit connection recovery.
 */
export function BrowserLiveView({
    accessId,
    epoch,
    control,
    onControlsChange,
}: {
    readonly accessId: string;
    readonly epoch: string;
    readonly control: boolean;
    readonly onControlsChange: (controls: BrowserViewControls | null) => void;
}) {
    const container = useRef<HTMLDivElement>(null);
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [zoom, changeZoom] = useReducer(nextZoom, 0);
    const scale = viewScales[zoom] ?? 1;
    const [clipboard, setClipboard] = useState<BrowserClipboardControls | null>(null);
    const [state, setState] = useState<"connecting" | "connected" | "disconnected">(
        "connecting"
    );
    useImperativeHandle<BrowserViewControls | null, BrowserViewControls | null>(
        onControlsChange,
        () =>
            state === "connected"
                ? {
                      zoomIn:
                          zoom < viewScales.length - 1 ? () => changeZoom("in") : null,
                      zoomOut: zoom > 0 ? () => changeZoom("out") : null,
                      fit: zoom > 0 ? () => changeZoom("fit") : null,
                      copy: control ? (clipboard?.copy ?? null) : null,
                      paste: control ? (clipboard?.paste ?? null) : null,
                  }
                : null,
        [clipboard, control, state, zoom]
    );
    useEffect(() => {
        const target = container.current;
        if (!target) return;
        let active = true;
        let painting = 0;
        const url = new URL("/api/mira/browser/display", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("id", accessId);
        const display = new RFB(target, url.href);
        display.scaleViewport = true;
        display.viewOnly = true;
        display.focusOnClick = false;
        display.background = "var(--color-primary-950)";
        const preserveEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") event.stopPropagation();
        };
        target.addEventListener("keydown", preserveEscape);
        const firstFrame = () => {
            if (!active) return;
            const canvas = target.querySelector("canvas");
            const context = canvas?.getContext("2d");
            if (
                canvas &&
                context &&
                canvas.width > 0 &&
                canvas.height > 0 &&
                context.getImageData(
                    Math.floor(canvas.width / 2),
                    Math.floor(canvas.height / 2),
                    1,
                    1
                ).data[3]
            ) {
                setState("connected");
                return;
            }
            painting = requestAnimationFrame(firstFrame);
        };
        display.addEventListener("connect", firstFrame);
        display.addEventListener("disconnect", () => {
            cancelAnimationFrame(painting);
            if (active) setState("disconnected");
        });
        display.addEventListener("credentialsrequired", () => display.disconnect());
        return () => {
            active = false;
            cancelAnimationFrame(painting);
            target.removeEventListener("keydown", preserveEscape);
            display.disconnect();
        };
    }, [accessId, attempt]);
    return (
        <section
            aria-label="Live Chromium browser"
            className="relative flex min-h-44 flex-1 flex-col"
        >
            <section
                className="@container-size flex min-h-24 flex-1 flex-col overflow-auto overscroll-contain bg-primary-950 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-400"
                aria-label="Browser viewport"
                tabIndex={control ? -1 : 0}
                onPointerDownCapture={(event) => {
                    if (!control) event.currentTarget.focus({ preventScroll: true });
                }}
                onKeyDownCapture={(event) => {
                    if (
                        state !== "connected" ||
                        (!event.ctrlKey && !event.metaKey) ||
                        event.altKey ||
                        (event.target instanceof HTMLElement &&
                            event.target.closest("button, textarea, input"))
                    )
                        return;
                    switch (event.key) {
                        case "+":
                        case "=": {
                            changeZoom("in");
                            break;
                        }
                        case "-": {
                            changeZoom("out");
                            break;
                        }
                        case "0": {
                            changeZoom("fit");
                            break;
                        }
                        default: {
                            return;
                        }
                    }
                    event.preventDefault();
                    event.stopPropagation();
                }}
            >
                <div
                    className="mx-auto grid shrink-0"
                    style={{ width: `min(${scale * 100}cqw, ${scale * 160}cqh)` }}
                >
                    <div className="relative col-start-1 row-start-1 overflow-hidden bg-primary-950">
                        <div
                            ref={container}
                            aria-label="Remote Chromium window"
                            inert={control}
                            className="aspect-8/5 w-full"
                        />
                        {state !== "connected" && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-inherit p-6 text-center">
                                <output className="text-sm text-primary-200">
                                    {state === "connecting"
                                        ? "Connecting to Chromium…"
                                        : "Browser display disconnected."}
                                </output>
                                {state === "disconnected" && (
                                    <Button
                                        variant="secondary"
                                        onClick={() => {
                                            setState("connecting");
                                            setAttempt((value) => value + 1);
                                        }}
                                    >
                                        <RefreshCw size={14} aria-hidden="true" />{" "}
                                        Reconnect display
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                    {control && state === "connected" && (
                        <BrowserInputLayer
                            key={epoch}
                            onControlsChange={setClipboard}
                            overlay={overlay}
                            accessId={accessId}
                            epoch={epoch}
                        />
                    )}
                </div>
            </section>
            <div ref={setOverlay} className="pointer-events-none absolute inset-0" />
        </section>
    );
}
