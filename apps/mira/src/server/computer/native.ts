import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type * as NativeSdk from "@trycua/cua-driver";
import { imageSize } from "image-size";

import { runtimeContentItems, type RuntimeToolResult } from "../runtime/toolResult";
import {
    computerDriverVersion,
    computerWindowGrant,
    computerWindowManifest,
} from "./policy";
import type { ComputerActionResult, ComputerWindowPort } from "./session";
import { openWindowsCapture, type WindowsCapturePort } from "./windowsCapture";

/**
 * Open the pinned native SDK with a fixed application ceiling and exact window adapter.
 * @param input - Host-approved canonical executable, PID/window and explicit delivery mode.
 * @param loadSdk - Native-module loader, replaceable by a synthetic driver in unit tests.
 * @param openCapture - Fixed Windows capture factory; synthetic substitution is only for tests.
 * @returns An exclusive port. The caller must close it and enforce interactive desktop readiness.
 */
export async function openNativeComputerWindow(
    input: unknown,
    loadSdk: () => Promise<typeof NativeSdk> = () => import("@trycua/cua-driver"),
    openCapture:
        | ((input: unknown) => Promise<WindowsCapturePort>)
        | null = process.platform === "win32" ? openWindowsCapture : null
): Promise<ComputerWindowPort> {
    const grant = computerWindowGrant(input);
    if ((await realpath(grant.executable)) !== grant.executable)
        throw new Error("Computer executable must use its canonical path.");
    const sdk = await loadSdk();
    const directory = await mkdtemp(path.join(os.tmpdir(), "homelab-computer-"));
    const manifest = path.join(directory, "capabilities.json");
    let driver: ReturnType<typeof sdk.CuaDriver.createConfigured> | undefined;
    let capture: WindowsCapturePort | undefined;
    try {
        await writeFile(manifest, JSON.stringify(computerWindowManifest(grant)), {
            mode: 0o600,
        });
        driver = sdk.CuaDriver.createConfigured({
            claudeCodeCompatibility: false,
            authorization: {
                allowedModes: [sdk.SessionPermissionMode.Bounded],
                compatibilityMode: sdk.SessionPermissionMode.Bounded,
                compatibilityCapabilityManifestPath: manifest,
                unrestrictedAcknowledged: false,
                maxSessionTtlSeconds: 300n,
                maxIdleTtlSeconds: 60n,
            },
        });
        const native = driver;
        const metadata = await native.metadata();
        if (metadata.driverVersion !== computerDriverVersion || !metadata.embedded)
            throw new Error("Unexpected computer driver version or execution mode.");
        capture = grant.mode === "view" ? await openCapture?.(grant) : undefined;
        const target = new sdk.ActionTarget.Window({
            pid: grant.pid,
            windowId: BigInt(grant.windowId),
        });
        let closed = false;
        let closing: Promise<void> | undefined;
        const ensureOpen = () => {
            if (closed) throw new Error("Computer driver is closed.");
        };
        return {
            observe: async (signal) => {
                ensureOpen();
                signal.throwIfAborted();
                const frame = await native.getWindowState(
                    {
                        pid: grant.pid,
                        windowId: BigInt(grant.windowId),
                        includeScreenshot: !capture,
                        includeAccessibilityTree: true,
                        maxImageDimension: 0,
                        maxElements: 200,
                        maxDepth: 12,
                        timeoutMs: 1000,
                        treeFormat: "markdown",
                    },
                    { signal }
                );
                signal.throwIfAborted();
                ensureOpen();
                if (
                    frame.pid !== grant.pid ||
                    frame.windowId !== BigInt(grant.windowId) ||
                    !frame.snapshotId ||
                    (capture
                        ? frame.images.length > 0
                        : frame.screenshotFrameValid === false ||
                          (process.platform !== "win32" &&
                              frame.screenshotFrameValid !== true) ||
                          frame.images.length !== 1)
                )
                    throw new Error(
                        "Computer driver did not return the selected window frame."
                    );
                const captured = await capture?.read(signal);
                signal.throwIfAborted();
                ensureOpen();
                const image = captured
                    ? { mimeType: "image/png", dataBase64: captured.dataBase64 }
                    : frame.images[0]!;
                if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")
                    throw new Error("Unsupported computer frame format.");
                const content: Exclude<RuntimeToolResult, string> = {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                title: frame.windowTitle?.slice(0, 512),
                                tree: frame.treeMarkdown?.slice(0, 64 * 1024),
                                treeComplete:
                                    frame.elementsComplete === true &&
                                    !frame.truncated &&
                                    !frame.degraded,
                            }),
                        },
                        {
                            type: "image",
                            mediaType: image.mimeType,
                            data: image.dataBase64,
                        },
                    ],
                };
                runtimeContentItems(content);
                const dimensions = imageSize(Buffer.from(image.dataBase64, "base64"));
                if (
                    dimensions.width !== (captured?.width ?? frame.screenshotWidth) ||
                    dimensions.height !== (captured?.height ?? frame.screenshotHeight)
                )
                    throw new Error("Computer frame dimensions do not match the image.");
                return {
                    snapshot: frame.snapshotId,
                    width: dimensions.width,
                    height: dimensions.height,
                    content,
                };
            },
            click: async (x, y, signal) => {
                ensureOpen();
                if (grant.mode === "view")
                    throw new Error("Computer access is view-only.");
                signal.throwIfAborted();
                const result = await native.click(
                    {
                        target,
                        position: new sdk.ClickPosition.Coordinates({ x, y }),
                        deliveryMode:
                            grant.delivery === "background"
                                ? sdk.InputDeliveryMode.Background
                                : sdk.InputDeliveryMode.Foreground,
                    },
                    { signal }
                );
                return { effect: actionEffect(result.effect) };
            },
            type: async (text, signal) => {
                ensureOpen();
                if (grant.mode === "view")
                    throw new Error("Computer access is view-only.");
                signal.throwIfAborted();
                // 0.37's typed TypeTextInput omits delivery_mode. Use the official wire
                // shape for this fixed tool only; neither tool names nor targets are model inputs.
                const result = await native.callTool(
                    "type_text",
                    JSON.stringify({
                        target: {
                            kind: "window",
                            pid: grant.pid,
                            window_id: Number(grant.windowId),
                        },
                        text,
                        delivery_mode: grant.delivery,
                    }),
                    { signal }
                );
                if (result.isError) return { effect: "unknown" };
                return {
                    effect: result.action
                        ? actionEffect(result.action.effect)
                        : "unverified",
                };
            },
            close: () => {
                closed = true;
                closing ??= (async () => {
                    try {
                        const captureClosing = capture?.close();
                        try {
                            await native.shutdown();
                        } finally {
                            await captureClosing;
                        }
                    } finally {
                        if (sdk.CuaDriver.instanceOf(native)) native.uniffiDestroy();
                        await rm(directory, { recursive: true, force: true });
                    }
                })();
                return closing;
            },
        };
    } catch (error) {
        try {
            if (driver) {
                try {
                    const captureClosing = capture?.close();
                    try {
                        await driver.shutdown();
                    } finally {
                        await captureClosing;
                    }
                } finally {
                    if (sdk.CuaDriver.instanceOf(driver)) driver.uniffiDestroy();
                }
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
        throw error;
    }
}

function actionEffect(effect: number): ComputerActionResult["effect"] {
    switch (effect) {
        case 0: {
            return "confirmed";
        }
        case 1: {
            return "partial";
        }
        case 2:
        case 3: {
            return "unverified";
        }
        case 4: {
            return "refused";
        }
        default: {
            return "unknown";
        }
    }
}
