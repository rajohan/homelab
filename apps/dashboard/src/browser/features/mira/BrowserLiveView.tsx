import { Button } from "@homelab/ui";
import RFB from "@novnc/novnc";
import { Maximize, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { BrowserInputLayer } from "./BrowserInputLayer";

/** Display the current Chromium window and route direct input only during operator control.
 * @returns A live, keyboard-focusable browser viewport with explicit connection recovery.
 */
export function BrowserLiveView({
    accessId,
    epoch,
    control,
}: {
    readonly accessId: string;
    readonly epoch: string;
    readonly control: boolean;
}) {
    const container = useRef<HTMLDivElement>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<"connecting" | "connected" | "disconnected">(
        "connecting"
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
        <section aria-label="Live Chromium browser" className="space-y-2">
            <div
                ref={viewport}
                className="group/browser grid [&:fullscreen]:grid-rows-[minmax(0,1fr)_auto] [&:fullscreen]:bg-primary-950"
            >
                <div className="relative col-start-1 row-start-1 overflow-hidden rounded-lg border border-primary-700 bg-surface-card">
                    <div
                        ref={container}
                        aria-label="Remote Chromium window"
                        inert={control}
                        className="aspect-8/5 min-h-48 w-full group-[:fullscreen]/browser:h-full group-[:fullscreen]/browser:min-h-0 sm:aspect-auto sm:h-[min(68dvh,50rem)] sm:min-h-64"
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
                                    <RefreshCw size={14} aria-hidden="true" /> Reconnect
                                    display
                                </Button>
                            )}
                        </div>
                    )}
                </div>
                {control && state === "connected" && (
                    <BrowserInputLayer key={epoch} accessId={accessId} epoch={epoch} />
                )}
            </div>
            <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-primary-300">
                    {control
                        ? "Click inside the browser to use your mouse and keyboard."
                        : "Live view · Take control to interact."}
                </p>
                <Button
                    variant="ghost"
                    onClick={() => {
                        void viewport.current?.requestFullscreen().catch(() => {});
                    }}
                >
                    <Maximize size={14} aria-hidden="true" /> Full screen
                </Button>
            </div>
        </section>
    );
}
