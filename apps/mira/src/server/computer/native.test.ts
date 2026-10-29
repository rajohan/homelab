import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";

import type * as NativeSdk from "@trycua/cua-driver";

import { createVisualChallenge } from "../testing/visualChallenge";
import { computerCommandResult } from "./commandResult";
import { openNativeComputerWindow } from "./native";
import { ComputerWindowSession } from "./session";
import { openWindowsCapture, windowsCaptureMaximumPngBytes } from "./windowsCapture";

async function fixture() {
    const executable = await realpath(process.execPath);
    const grant: {
        executable: string;
        pid: number;
        windowId: string;
        delivery: string;
        mode?: "view" | "control";
    } = { executable, pid: 123, windowId: "456", delivery: "background" };
    let manifest = "";
    let shuts = 0;
    let destroys = 0;
    let version = "0.37.0";
    const calls: unknown[] = [];
    const frame = {
        pid: 123,
        windowId: 456n,
        snapshotId: "s00000001",
        degraded: false,
        elements: [
            {
                elementToken: "s00000001:1",
                role: "button",
                label: "Fixture",
                enabled: true,
            },
        ],
        screenshotFrameValid: true as boolean | undefined,
        screenshotWidth: 390,
        screenshotHeight: 110,
        windowTitle: "Synthetic",
        treeMarkdown: "fixture",
        elementsComplete: true,
        images: [{ mimeType: "image/png", dataBase64: createVisualChallenge().data }],
    };
    const native = {
        metadata: () => Promise.resolve({ driverVersion: version, embedded: true }),
        getWindowState: (input: unknown) => {
            calls.push(input);
            return Promise.resolve(frame);
        },
        click: (input: unknown) => {
            calls.push(input);
            return Promise.resolve({ effect: 2 });
        },
        callTool: (name: string, input: string) => {
            calls.push({ name, input: JSON.parse(input) as unknown });
            return Promise.resolve({ isError: false, action: { effect: 0 } } as {
                isError: boolean;
                action?: { effect: number };
            });
        },
        shutdown: () => {
            shuts++;
            return Promise.resolve();
        },
        uniffiDestroy: () => {
            destroys++;
        },
    };
    class Fields {
        value: unknown;
        /** Store synthetic SDK constructor fields for request assertions.
         * @param value - Fields passed to the SDK constructor.
         */
        constructor(value: unknown) {
            this.value = value;
        }
    }
    const sdk = {
        CuaDriver: {
            instanceOf: () => true,
            createConfigured: (options: {
                authorization: { compatibilityCapabilityManifestPath: string };
            }) => {
                manifest = options.authorization.compatibilityCapabilityManifestPath;
                calls.push(options);
                return native;
            },
        },
        SessionPermissionMode: { Bounded: 1 },
        InputDeliveryMode: { Background: 0, Foreground: 1 },
        ActionTarget: { Window: Fields },
        ClickPosition: { Coordinates: Fields, Element: Fields },
    } as unknown as typeof NativeSdk;
    return {
        grant,
        native,
        sdk,
        frame,
        calls,
        open: () => openNativeComputerWindow(grant, () => Promise.resolve(sdk), null),
        manifest: () => manifest,
        shuts: () => shuts,
        destroys: () => destroys,
        version: (value: string) => {
            version = value;
        },
    };
}
const signal = () => new AbortController().signal;

test("native adapter pins permission mode, exact window, fixed text tool and literal delivery", async () => {
    const f = await fixture();
    const driver = await f.open();
    const manifest: unknown = await Bun.file(f.manifest()).json();
    expect(manifest).toMatchObject({ resources: { desktop: { display: false } } });
    const frame = await driver.observe(signal());
    expect(frame.width).toBe(390);
    expect(frame.height).toBe(110);
    expect(
        JSON.parse(
            frame.content.content[0]!.type === "text"
                ? frame.content.content[0]!.text
                : "{}"
        )
    ).toEqual({ title: "Synthetic", tree: "fixture", treeComplete: true });
    expect(await driver.click(15, 25, signal())).toEqual({ effect: "unverified" });
    expect(await driver.type("literal text", signal())).toEqual({ effect: "confirmed" });
    expect(f.calls[1]).toMatchObject({
        pid: 123,
        windowId: 456n,
        includeScreenshot: true,
        maxImageDimension: 0,
    });
    expect(f.calls[2]).toMatchObject({
        target: { value: { pid: 123, windowId: 456n } },
        deliveryMode: 0,
    });
    expect(f.calls[3]).toEqual({
        name: "type_text",
        input: {
            target: { kind: "window", pid: 123, window_id: 456 },
            text: "literal text",
            delivery_mode: "background",
        },
    });
    await Promise.all([driver.close(), driver.close()]);
    expect(f.shuts()).toBe(1);
    expect(f.destroys()).toBe(1);
    expect(await Bun.file(f.manifest()).exists()).toBe(false);
    await assert.rejects(driver.observe(signal()), /closed/);
    await assert.rejects(driver.click(0, 0, signal()), /closed/);
    await assert.rejects(driver.type("x", signal()), /closed/);
});

test("legacy SDK capture accepts omitted validity only on Windows", async () => {
    const f = await fixture();
    f.frame.screenshotFrameValid = undefined;
    const driver = await f.open();
    try {
        if (process.platform === "win32") {
            const frame = await driver.observe(signal());
            expect(frame.width).toBe(390);
        } else await assert.rejects(driver.observe(signal()), /selected window frame/);
    } finally {
        await driver.close();
    }
});

test("native refusals and incomplete effects never become confirmed success", async () => {
    const f = await fixture();
    f.grant.delivery = "foreground";
    const driver = await f.open();
    for (const [effect, expected] of [
        [0, "confirmed"],
        [1, "partial"],
        [2, "unverified"],
        [3, "unverified"],
        [4, "refused"],
        [99, "unknown"],
    ] as const) {
        f.native.click = () => Promise.resolve({ effect });
        expect(await driver.click(0, 0, signal())).toEqual({ effect: expected });
    }
    f.native.callTool = () => Promise.resolve({ isError: true });
    expect(await driver.type("x", signal())).toEqual({ effect: "unknown" });
    f.native.callTool = () => Promise.resolve({ isError: false });
    expect(await driver.type("x", signal())).toEqual({ effect: "unverified" });
    await driver.close();
});

test("wrong identities, invalid pixels and undeclared remote files are rejected", async () => {
    for (const mode of [
        "pid",
        "window",
        "invalid",
        "size",
        "mime",
        "multiple",
        "remote",
        "snapshot",
    ]) {
        const f = await fixture();
        const driver = await f.open();
        if (mode === "pid") f.frame.pid = 999;
        if (mode === "window") f.frame.windowId = 999n;
        if (mode === "invalid") f.frame.screenshotFrameValid = false;
        if (mode === "size") f.frame.screenshotWidth = 800;
        if (mode === "mime") f.frame.images[0]!.mimeType = "image/svg+xml";
        if (mode === "multiple") f.frame.images.push(f.frame.images[0]!);
        if (mode === "remote")
            f.frame.images[0]!.dataBase64 = "https://private.invalid/image";
        if (mode === "snapshot") f.frame.snapshotId = "";
        await assert.rejects(driver.observe(signal()));
        await driver.close();
    }
});

test("version mismatch cleans up the native runtime and temporary manifest", async () => {
    const f = await fixture();
    f.version("0.38.0");
    await assert.rejects(f.open(), /version/);
    expect(f.shuts()).toBe(1);
    expect(f.destroys()).toBe(1);
    expect(await Bun.file(f.manifest()).exists()).toBe(false);
});

test("cancellation discards a native frame before publishing its pixels", async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.native.getWindowState = () => {
        abort.abort();
        return Promise.resolve(f.frame);
    };
    const driver = await f.open();
    await assert.rejects(driver.observe(abort.signal));
    await driver.close();
});

test("native shutdown failure still releases its handle and temporary manifest", async () => {
    const f = await fixture();
    f.native.shutdown = () => Promise.reject(new Error("native shutdown failed"));
    const driver = await f.open();
    await assert.rejects(driver.close(), /shutdown/);
    expect(f.destroys()).toBe(1);
    expect(await Bun.file(f.manifest()).exists()).toBe(false);
});

test("view-only native policy omits input tools and the adapter refuses them before SDK dispatch", async () => {
    const f = await fixture();
    f.grant.mode = "view";
    const driver = await f.open();
    try {
        expect(await Bun.file(f.manifest()).json()).toMatchObject({
            allow: { tools: ["get_window_state"] },
        });
        await driver.observe(signal());
        const before = f.calls.length;
        await assert.rejects(driver.click(1, 1, signal()), /view-only/);
        await assert.rejects(driver.type("Never sent", signal()), /view-only/);
        expect(f.calls).toHaveLength(before);
    } finally {
        await driver.close();
    }
});

test("Windows view adapter uses only window-only images and never dispatches input", async () => {
    const f = await fixture();
    f.grant.mode = "view";
    f.frame.images = [];
    f.frame.screenshotFrameValid = undefined;
    let reads = 0,
        closes = 0;
    const capture = {
        read: () => {
            reads++;
            return Promise.resolve({
                width: 390,
                height: 110,
                dataBase64: createVisualChallenge().data,
            });
        },
        close: () => {
            closes++;
            return Promise.resolve();
        },
    };
    const driver = await openNativeComputerWindow(
        f.grant,
        () => Promise.resolve(f.sdk),
        () => Promise.resolve(capture)
    );
    const frame = await driver.observe(signal());
    expect(frame.width).toBe(390);
    expect(f.calls[1]).toMatchObject({
        includeScreenshot: false,
        includeAccessibilityTree: true,
        treeFormat: "elements",
    });
    const before = f.calls.length;
    await assert.rejects(driver.click(15, 25, signal()), /view-only/);
    await assert.rejects(driver.type("not sent", signal()), /view-only/);
    expect(f.calls).toHaveLength(before);
    expect(reads).toBe(1);
    await driver.close();
    expect(closes).toBe(1);
});

test("Windows view refuses SDK pixels, invalid geometry and missing capture without fallback", async () => {
    const f = await fixture();
    f.grant.mode = "view";
    let width = 390;
    let reads = 0;
    const capture = {
        read: () => {
            reads++;
            return Promise.resolve({
                width,
                height: 110,
                dataBase64: createVisualChallenge().data,
            });
        },
        close: () => Promise.resolve(),
    };
    const driver = await openNativeComputerWindow(
        f.grant,
        () => Promise.resolve(f.sdk),
        () => Promise.resolve(capture)
    );
    await assert.rejects(driver.observe(signal()), /selected window frame/);
    expect(reads).toBe(0);
    f.frame.images = [];
    await driver.observe(signal());
    width = 391;
    await assert.rejects(driver.observe(signal()), /dimensions/);
    await driver.close();
    const missing = await fixture();
    missing.grant.mode = "view";
    await assert.rejects(
        openNativeComputerWindow(
            missing.grant,
            () => Promise.resolve(missing.sdk),
            () => Promise.reject(new Error("capture missing"))
        ),
        /capture missing/
    );
    expect(missing.shuts()).toBe(1);
});

function paddedPng(length: number) {
    const original = Buffer.from(createVisualChallenge().data, "base64");
    const chunk = Buffer.alloc(length - original.length, 0x61);
    chunk.writeUInt32BE(chunk.length - 12, 0);
    chunk.write("tEXt", 4, "ascii");
    chunk.write("padding\0", 8, "ascii");
    chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]);
}

test("largest accepted PNG plus near-limit escaped tree fits both private transport envelopes", async () => {
    const f = await fixture();
    f.grant.mode = "view";
    f.frame.images = [];
    f.frame.treeMarkdown = "\u0001".repeat(42 * 1024);
    f.frame.windowTitle = "\u0001".repeat(512);
    let bytes = paddedPng(windowsCaptureMaximumPngBytes);
    const capture = await openWindowsCapture({ ...f.grant, startedAt: "123" }, () =>
        Promise.resolve(bytes)
    );
    const driver = await openNativeComputerWindow(
        f.grant,
        () => Promise.resolve(f.sdk),
        () => Promise.resolve(capture)
    );
    try {
        const observation = await driver.observe(signal());
        const text = observation.content.content.find((item) => item.type === "text");
        expect(text?.type === "text" ? text.text.length : 0).toBeGreaterThan(260_000);
        const body = JSON.stringify({ id: 1, result: observation });
        // This is stricter than the 4 MiB worker RPC and leaves 16 KiB for machine binding metadata.
        expect(Buffer.byteLength(body)).toBeLessThan(3 * 1024 * 1024 - 16 * 1024);
        bytes = paddedPng(windowsCaptureMaximumPngBytes + 1);
        await assert.rejects(driver.observe(signal()), /unavailable/);
    } finally {
        await driver.close();
    }
});

test("Windows control uses only its captured image and observed SDK element tokens", async () => {
    const f = await fixture();
    f.grant.mode = "control";
    f.frame.images = [];
    const capture = {
        read: () =>
            Promise.resolve({
                width: 390,
                height: 110,
                dataBase64: createVisualChallenge().data,
            }),
        close: () => Promise.resolve(),
    };
    const driver = await openNativeComputerWindow(
        f.grant,
        () => Promise.resolve(f.sdk),
        () => Promise.resolve(capture)
    );
    try {
        const frame = await driver.observe(signal());
        expect(frame.coordinateInput).toBe(false);
        expect(frame.elements).toEqual([
            { token: "s00000001:1", role: "button", label: "Fixture" },
        ]);
        const before = f.calls.length;
        expect(await driver.click(1, 1, signal())).toEqual({ effect: "refused" });
        expect(await driver.clickElement("s00000001:1", signal())).toEqual({
            effect: "refused",
        });
        expect(f.calls).toHaveLength(before);
        await driver.observe(signal());
        expect(await driver.clickElement("s00000001:1", signal())).toEqual({
            effect: "unverified",
        });
        expect(f.calls.at(-1)).toMatchObject({
            target: { value: { pid: 123, windowId: 456n } },
            position: { value: { elementToken: "s00000001:1" } },
            deliveryMode: 0,
        });
        expect(await driver.clickElement("s00000001:1", signal())).toEqual({
            effect: "refused",
        });
        await driver.observe(signal());
        expect(await driver.clickElement("s00000002:1", signal())).toEqual({
            effect: "refused",
        });
        expect(await driver.clickElement("s00000001:1", signal())).toEqual({
            effect: "refused",
        });
        await driver.observe(signal());
        await driver.type("literal", signal());
        expect(await driver.clickElement("s00000001:1", signal())).toEqual({
            effect: "refused",
        });
    } finally {
        await driver.close();
    }
});

test("Windows targets exclude disabled, foreign and degraded elements and reject duplicate tokens", async () => {
    const f = await fixture();
    f.grant.mode = "control";
    f.frame.images = [];
    const capture = {
        read: () =>
            Promise.resolve({
                width: 390,
                height: 110,
                dataBase64: createVisualChallenge().data,
            }),
        close: () => Promise.resolve(),
    };
    const driver = await openNativeComputerWindow(
        f.grant,
        () => Promise.resolve(f.sdk),
        () => Promise.resolve(capture)
    );
    try {
        f.frame.elements.push(
            {
                elementToken: "s00000001:2",
                role: "button",
                label: "Disabled",
                enabled: false,
            },
            {
                elementToken: "s00000002:3",
                role: "button",
                label: "Foreign",
                enabled: true,
            }
        );
        const normal = await driver.observe(signal());
        expect(normal.elements).toHaveLength(1);
        f.frame.degraded = true;
        const degraded = await driver.observe(signal());
        expect(degraded.elements).toEqual([]);
        f.frame.degraded = false;
        f.frame.elements.push(f.frame.elements[0]!);
        await assert.rejects(driver.observe(signal()));
        expect(await driver.clickElement("s00000001:1", signal())).toEqual({
            effect: "refused",
        });
    } finally {
        await driver.close();
    }
});

test("maximum PNG and escaped element labels fit the machine transport after tree removal", async () => {
    const f = await fixture();
    f.grant.mode = "control";
    f.frame.images = [];
    f.frame.treeMarkdown = "\u0001".repeat(42 * 1024);
    f.frame.elements = Array.from({ length: 200 }, (_, index) => ({
        elementToken: `s00000001:${index}`,
        enabled: true,
        role: "\u0001".repeat(64),
        label: "\u0001".repeat(128),
    }));
    const capture = await openWindowsCapture({ ...f.grant, startedAt: "123" }, () =>
        Promise.resolve(paddedPng(windowsCaptureMaximumPngBytes))
    );
    const driver = await openNativeComputerWindow(
        f.grant,
        () => Promise.resolve(f.sdk),
        () => Promise.resolve(capture)
    );
    const session = new ComputerWindowSession(driver, () => Promise.resolve());
    try {
        const observation = await session.observe(signal());
        const result = computerCommandResult("observe", observation);
        expect(observation.elements).toHaveLength(200);
        expect(Buffer.byteLength(JSON.stringify({ result }))).toBeLessThan(
            3 * 1024 * 1024 - 16 * 1024
        );
    } finally {
        await session.close();
    }
});
