import { setTimeout as delay } from "node:timers/promises";

import type { miraBrowserActionSchema } from "@homelab/contracts/miraBrowser";
import {
    browserClipboardCommandSchema,
    browserClipboardTextSchema,
} from "@homelab/contracts/miraBrowserClipboard";
import { imageSize } from "image-size";
import * as v from "valibot";

type Action = Exclude<
    v.InferOutput<typeof miraBrowserActionSchema>,
    { action: "click" | "type" }
>;

const desktopEnvironment = {
    DISPLAY: ":99",
    XAUTHORITY: "/tmp/mira-browser.xauth",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
};

async function desktop(
    command: string[],
    signal: AbortSignal,
    maximum = 4 * 1024 * 1024
) {
    signal.throwIfAborted();
    const child = Bun.spawn(command, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: desktopEnvironment,
    });
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of child.stdout) {
            length += chunk.length;
            if (length > maximum)
                throw new Error("Browser desktop output exceeds its bound.");
            chunks.push(chunk);
        }
        if ((await child.exited) !== 0)
            throw new Error("Browser desktop operation failed.");
        signal.throwIfAborted();
        return Buffer.concat(chunks);
    } finally {
        signal.removeEventListener("abort", stop);
        if (child.exitCode === null) {
            child.kill();
            await child.exited;
        }
    }
}

async function pasteBrowserText(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
    // Keep Unicode text only for this paste, then release its selection owner.
    // Human clipboard transfer is separately authorized by the live console.
    const clipboard = Bun.spawn(
        ["/usr/bin/xclip", "-selection", "clipboard", "-in", "-quiet"],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe", env: desktopEnvironment }
    );
    const stop = () => clipboard.kill();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
        await clipboard.stdin.write(text);
        await clipboard.stdin.end();
        let status = "";
        let ready = false;
        const reader = clipboard.stderr.getReader();
        try {
            while (!ready) {
                const { value, done } = await reader.read();
                if (done) break;
                status += Buffer.from(value).toString("utf8");
                if (status.length > 8192)
                    throw new Error("Browser text input did not become ready.");
                ready = status.includes("Waiting for selection requests");
            }
        } finally {
            reader.releaseLock();
        }
        if (!ready) throw new Error("Browser text input is unavailable.");
        signal.throwIfAborted();
        await desktop(["/usr/bin/xdotool", "key", "--clearmodifiers", "ctrl+v"], signal);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(finish, 500);
            function finish() {
                signal.removeEventListener("abort", cancel);
                resolve();
            }
            function cancel() {
                clearTimeout(timer);
                signal.removeEventListener("abort", cancel);
                reject(
                    new Error("Browser text input was cancelled.", {
                        cause: signal.reason,
                    })
                );
            }
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
        });
        signal.throwIfAborted();
    } finally {
        signal.removeEventListener("abort", stop);
        if (clipboard.exitCode === null) clipboard.kill();
        await clipboard.exited;
    }
}

/** Capture the isolated Chromium desktop directly in memory, including browser controls.
 * @param signal - Current operation cancellation; no screenshot file is created.
 * @returns A bounded PNG/JPEG and unchanged native dimensions for coordinate input.
 */
export async function browserDesktopFrame(signal: AbortSignal) {
    let bytes = await desktop(
        ["/usr/bin/python3", "-I", "/opt/mira-browser/capture.py", "png"],
        signal
    );
    let mediaType: "image/png" | "image/jpeg" = "image/png";
    if (bytes.length > 2 * 1024 * 1024) {
        bytes = await desktop(
            ["/usr/bin/python3", "-I", "/opt/mira-browser/capture.py", "jpg"],
            signal
        );
        mediaType = "image/jpeg";
    }
    if (bytes.length > 2 * 1024 * 1024)
        throw new Error("Browser screenshot exceeds its transport budget.");
    const { width, height } = imageSize(bytes);
    if (!width || !height || width > 8192 || height > 8192)
        throw new Error("Invalid browser desktop dimensions.");
    return { width, height, mediaType, data: bytes.toString("base64") };
}

/** Deliver one bounded native action inside the isolated Chromium desktop.
 * @param action - Validated action; executable names and command structure are fixed.
 * @param frame - Dimensions from the fresh, single-use observation.
 * @param signal - Current operation cancellation; interrupted input is never replayed.
 */
export async function browserDesktopInput(
    action: Action,
    frame: { width: number; height: number },
    signal: AbortSignal
) {
    const point = (x: number, y: number) => {
        if (x >= frame.width || y >= frame.height)
            throw new Error("Choose a point inside the observed browser image.");
        return ["mousemove", String(x), String(y)];
    };
    let command: string[];
    if (action.action === "type_text") {
        await pasteBrowserText(action.text, signal);
        return;
    }
    if (action.action === "key")
        command = [
            "key",
            "--clearmodifiers",
            [...action.modifiers, action.key].join("+"),
        ];
    else if (action.action === "move") command = point(action.x, action.y);
    else if (action.action === "click_at")
        command = [
            ...point(action.x, action.y),
            "click",
            "--repeat",
            String(action.count),
            "--delay",
            "100",
            String({ left: 1, middle: 2, right: 3 }[action.button]),
        ];
    else if (action.action === "scroll") {
        command = point(action.x, action.y);
        for (const [amount, positive, negative] of [
            [action.deltaY, 5, 4],
            [action.deltaX, 7, 6],
        ]) {
            if (amount)
                command.push(
                    "click",
                    "--repeat",
                    String(Math.ceil(Math.abs(amount) / 120)),
                    "--delay",
                    "10",
                    String(amount > 0 ? positive : negative)
                );
        }
    } else {
        point(action.toX, action.toY);
        command = [...point(action.x, action.y), "mousedown", "1"];
        for (let step = 1; step <= 12; step++)
            command.push(
                "mousemove",
                String(Math.round(action.x + ((action.toX - action.x) * step) / 12)),
                String(Math.round(action.y + ((action.toY - action.y) * step) / 12)),
                "sleep",
                "0.02"
            );
        command.push("mouseup", "1");
    }
    try {
        await desktop(["/usr/bin/xdotool", ...command], signal);
    } finally {
        if (action.action === "drag")
            await desktop(
                ["/usr/bin/xdotool", "mouseup", "1"],
                AbortSignal.timeout(5000)
            );
    }
}

/** Transfer plain Unicode text for an authenticated human console gesture.
 * @param input - Fixed copy, read or paste operation; no executable or shell input.
 * @param signal - Session cancellation, including container retirement.
 * @returns Bounded text or a redacted failure, never clipboard contents in diagnostics.
 */
export async function browserDesktopClipboard(input: unknown, signal: AbortSignal) {
    const command = v.parse(browserClipboardCommandSchema, input);
    try {
        if (command.kind === "paste") {
            await pasteBrowserText(command.text, signal);
            return { ok: true as const, text: "" };
        }
        if (command.kind === "copy") {
            await desktop(
                ["/usr/bin/xdotool", "key", "--clearmodifiers", "ctrl+c"],
                signal
            );
            await delay(150, undefined, { signal });
        }
        const bytes = await desktop(
            [
                "/usr/bin/xclip",
                "-selection",
                "clipboard",
                "-out",
                "-target",
                "UTF8_STRING",
            ],
            signal,
            32 * 1024
        );
        const text = v.parse(
            browserClipboardTextSchema,
            new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        );
        return { ok: true as const, text };
    } catch {
        signal.throwIfAborted();
        return { ok: false as const };
    }
}
