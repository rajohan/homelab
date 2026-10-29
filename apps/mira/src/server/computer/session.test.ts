import { expect, test } from "bun:test";
import assert from "node:assert/strict";

import { createVisualChallenge } from "../testing/visualChallenge";
import { ComputerWindowSession, type ComputerWindowPort } from "./session";

function fixture() {
    let clock = 100;
    let available = true;
    const actions: string[] = [];
    let closes = 0;
    const port: ComputerWindowPort = {
        observe: () =>
            Promise.resolve({
                snapshot: "native-1",
                width: 390,
                height: 110,
                content: {
                    content: [
                        {
                            type: "image",
                            mediaType: "image/png",
                            data: createVisualChallenge().data,
                        },
                    ],
                },
            }),
        clickElement: () => Promise.resolve({ effect: "refused" as const }),
        click: () => {
            actions.push("click");
            return Promise.resolve({ effect: "unverified" });
        },
        type: () => {
            actions.push("type");
            return Promise.resolve({ effect: "confirmed" });
        },
        close: () => {
            closes++;
            return Promise.resolve();
        },
    };
    const session = new ComputerWindowSession(
        port,
        () =>
            available
                ? Promise.resolve()
                : Promise.reject(new Error("Host no longer permits control.")),
        () => clock
    );
    return {
        port,
        session,
        actions,
        closes: () => closes,
        advance: (ms: number) => {
            clock += ms;
        },
        revoke: () => {
            available = false;
        },
    };
}
const signal = () => new AbortController().signal;

test("one fresh observation permits one input and preserves an unverified outcome", async () => {
    const f = fixture();
    const frame = await f.session.observe(signal());
    const command = { action: "click", observationId: frame.observationId, x: 20, y: 20 };
    expect(await f.session.act(command, signal())).toEqual({ effect: "unverified" });
    await assert.rejects(f.session.act(command, signal()), /fresh/);
    const next = await f.session.observe(signal());
    expect(
        await f.session.act(
            { action: "type", observationId: next.observationId, text: "Mira" },
            signal()
        )
    ).toEqual({ effect: "confirmed" });
    expect(f.actions).toEqual(["click", "type"]);
    await f.session.close();
});

test("stale, superseded, cross-session and out-of-frame inputs never reach the driver", async () => {
    for (const mode of ["old", "superseded", "foreign", "outside", "clock"]) {
        const f = fixture();
        const frame = await f.session.observe(signal());
        let id = frame.observationId;
        if (mode === "old") f.advance(10_001);
        if (mode === "clock") f.advance(-1);
        if (mode === "superseded") await f.session.observe(signal());
        if (mode === "foreign") id = crypto.randomUUID();
        await assert.rejects(
            f.session.act(
                {
                    action: "click",
                    observationId: id,
                    x: mode === "outside" ? 390 : 1,
                    y: 1,
                },
                signal()
            )
        );
        expect(f.actions).toEqual([]);
        await f.session.close();
    }
});

test("public input cannot add a target, arbitrary tool, oversized text or non-finite coordinates", async () => {
    const f = fixture();
    const frame = await f.session.observe(signal());
    for (const extra of [
        { action: "shell", text: "true" },
        { action: "type", text: "x", pid: 1 },
        { action: "type", text: "x".repeat(4097) },
        { action: "click", x: Number.NaN, y: 1 },
        { action: "click", x: -1, y: 1 },
    ])
        await assert.rejects(
            f.session.act({ observationId: frame.observationId, ...extra }, signal())
        );
    expect(f.actions).toEqual([]);
    await f.session.close();
});

test("a revoked host gate stops input even when the model holds a valid observation", async () => {
    const f = fixture();
    const frame = await f.session.observe(signal());
    f.revoke();
    await assert.rejects(
        f.session.act(
            { action: "type", observationId: frame.observationId, text: "x" },
            signal()
        ),
        /Host/
    );
    expect(f.actions).toEqual([]);
    await assert.rejects(f.session.observe(signal()), /Host/);
    await f.session.close();
});

test("a late observation is discarded after cancellation or host revocation", async () => {
    for (const mode of ["abort", "revoke"]) {
        const f = fixture();
        const original = f.port.observe;
        const abort = new AbortController();
        f.port.observe = async (s) => {
            const frame = await original(s);
            if (mode === "abort") abort.abort();
            else f.revoke();
            return frame;
        };
        await assert.rejects(f.session.observe(abort.signal));
        expect(f.actions).toEqual([]);
        await f.session.close();
    }
});

test("possibly delivered cancellation and driver errors retire authority without replay", async () => {
    for (const mode of ["abort", "error", "unknown", "revoke"]) {
        const f = fixture();
        const abort = new AbortController();
        f.port.type = () => {
            f.actions.push("type");
            if (mode === "abort") abort.abort();
            if (mode === "revoke") f.revoke();
            if (mode === "error")
                return Promise.reject(new Error("native detail must not escape"));
            return Promise.resolve({
                effect: mode === "unknown" ? "unknown" : "confirmed",
            });
        };
        const frame = await f.session.observe(signal());
        expect(
            await f.session.act(
                { action: "type", observationId: frame.observationId, text: "x" },
                abort.signal
            )
        ).toEqual({ effect: "unknown" });
        await assert.rejects(f.session.observe(signal()), /stopped/);
        expect(f.actions).toEqual(["type"]);
        await f.session.close();
        expect(f.closes()).toBe(1);
    }
});

test("local stop aborts an active observation and rejects overlapping callers", async () => {
    const f = fixture();
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
        entered = resolve;
    });
    f.port.observe = (s) =>
        new Promise((_resolve, reject) => {
            entered();
            s.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
            });
        });
    const read = f.session.observe(signal());
    await pending;
    await assert.rejects(f.session.observe(signal()), /active call/);
    await f.session.close();
    await assert.rejects(read, /aborted/);
    await assert.rejects(f.session.observe(signal()), /stopped/);
    expect(f.closes()).toBe(1);
});

test("invalid frames and remote image references never create usable observations", async () => {
    for (const mode of ["dimensions", "missing", "multiple", "remote"]) {
        const f = fixture();
        const original = f.port.observe;
        f.port.observe = async (s) => {
            const frame = await original(s);
            if (mode === "dimensions") frame.width = 0;
            if (mode === "missing")
                frame.content = { content: [{ type: "text", text: "no image" }] };
            if (mode === "multiple")
                frame.content.content.push(frame.content.content[0]!);
            if (mode === "remote")
                frame.content = {
                    content: [
                        {
                            type: "image",
                            mediaType: "image/png",
                            data: "https://private.invalid/secret",
                        },
                    ],
                };
            return frame;
        };
        await assert.rejects(f.session.observe(signal()));
        await f.session.close();
    }
});

function elementFixture() {
    const f = fixture();
    const read = f.port.observe;
    f.port.observe = async (s) => ({
        ...(await read(s)),
        coordinateInput: false,
        elements: [
            { token: "s00000001:1", role: "button", label: "Untrusted fixture label" },
        ],
    });
    f.port.clickElement = (token) => {
        f.actions.push(token);
        return Promise.resolve({ effect: "confirmed" });
    };
    return f;
}

test("element input requires current membership and is consumed once", async () => {
    const f = elementFixture();
    const frame = await f.session.observe(signal());
    expect(frame.elements?.[0]?.label).toBe("Untrusted fixture label");
    const command = {
        action: "click_element",
        observationId: frame.observationId,
        elementToken: "s00000001:1",
    };
    expect(await f.session.act(command, signal())).toEqual({ effect: "confirmed" });
    await assert.rejects(f.session.act(command, signal()), /fresh/);
    expect(f.actions).toEqual(["s00000001:1"]);
    await f.session.close();
});

test("expired, foreign and missing elements never dispatch", async () => {
    for (const mode of [
        "expired",
        "foreign",
        "missing",

        "coordinates",
        "revoked",
    ]) {
        const f = elementFixture();
        const frame = await f.session.observe(signal());
        if (mode === "expired") f.advance(10_001);
        if (mode === "revoked") f.revoke();
        await assert.rejects(
            f.session.act(
                mode === "coordinates"
                    ? { action: "click", observationId: frame.observationId, x: 1, y: 1 }
                    : {
                          action: "click_element",
                          observationId: frame.observationId,
                          elementToken:
                              mode === "foreign"
                                  ? "s00000002:1"
                                  : "s00000001:" + (mode === "missing" ? "9" : "1"),
                      },
                signal()
            )
        );
        expect(f.actions).toEqual([]);
        await f.session.close();
    }
});

test("session exports pixels and bounded targets without raw driver tree text", async () => {
    const f = elementFixture();
    const read = f.port.observe;
    f.port.observe = async (s) => {
        const frame = await read(s);
        frame.content.content.push({
            type: "text",
            text: "untrusted raw tree instructions",
        });
        return frame;
    };
    const frame = await f.session.observe(signal());
    expect(frame.content).toHaveLength(1);
    expect(frame.content[0]?.type).toBe("image");
    expect(frame.elements).toHaveLength(1);
    await f.session.close();
});
