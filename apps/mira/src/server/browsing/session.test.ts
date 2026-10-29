import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import type { openBrowserWorker } from "./process";
import { openBrowserSession } from "./session";

type Port = Awaited<ReturnType<typeof openBrowserWorker>>;
const frame: Awaited<ReturnType<Port["observe"]>> = {
    observationId: crypto.randomUUID(),
    url: "https://fixture.invalid",
    title: "Synthetic",
    outline: "Fixture",
    complete: true,
    refs: [],
    width: 1,
    height: 1,
    content: { content: [{ type: "image", mediaType: "image/png", data: "synthetic" }] },
};
function fixture() {
    const owner = new AbortController(),
        runtime = new AbortController();
    const calls: string[] = [];
    let permits = 5000,
        denied = false,
        releaseFailed = false,
        cleanupFailed = false;
    let heldCheck: Promise<{ validForMs: number }> | undefined;
    let opening: Promise<Port> | undefined;
    let observing: Promise<typeof frame> | undefined;
    let acting: Promise<{ effect: "unverified" }> | undefined;
    let closing: Promise<void> | undefined;
    let input: unknown;
    const port: Port = {
        signal: runtime.signal,
        observe: () => {
            calls.push("observe");
            return observing ?? Promise.resolve(frame);
        },
        navigate: (url) => {
            calls.push("navigate");
            return Promise.resolve({ url: String(url) });
        },
        act: (value) => {
            calls.push("act");
            input = value;
            return acting ?? Promise.resolve({ effect: "unverified" });
        },
        close: async () => {
            calls.push("close");
            runtime.abort();
            await closing;
            if (cleanupFailed) throw new Error("private engine output");
        },
    };
    const access = {
        check: async (mode: "view" | "control") => {
            calls.push(`check:${mode}`);
            if (denied) throw new Error("private identity failure");
            return heldCheck ?? { validForMs: permits };
        },
        release: () => {
            calls.push("release");
            return releaseFailed
                ? Promise.reject(new Error("private database output"))
                : Promise.resolve();
        },
    };
    const open = (signal: AbortSignal) => {
        calls.push("open");
        signal.addEventListener("abort", () => calls.push("abort"), { once: true });
        return opening ?? Promise.resolve(port);
    };
    return {
        owner,
        runtime,
        calls,
        port,
        access,
        open,
        start: () => openBrowserSession(open, access, owner.signal),
        permits: (value: number) => {
            permits = value;
        },
        deny: () => {
            denied = true;
        },
        holdCheck: (value: Promise<{ validForMs: number }>) => {
            heldCheck = value;
        },
        holdOpen: (value: Promise<Port>) => {
            opening = value;
        },
        holdObserve: (value: Promise<typeof frame>) => {
            observing = value;
        },
        holdAct: (value: Promise<{ effect: "unverified" }>) => {
            acting = value;
        },
        holdClose: (value: Promise<void>) => {
            closing = value;
        },
        failCleanup: () => {
            cleanupFailed = true;
        },
        failRelease: () => {
            releaseFailed = true;
        },
        input: () => input,
    };
}
async function until(predicate: () => boolean) {
    const deadline = performance.now() + 2000;
    while (!predicate() && performance.now() < deadline) await Bun.sleep(1);
    expect(predicate()).toBe(true);
}

test("host checks both sides of every scoped operation and releases only after close", async () => {
    const f = fixture(),
        s = await f.start();
    try {
        expect(await s.observe(f.owner.signal)).toBe(frame);
        await s.navigate("https://fixture.invalid/next", f.owner.signal);
        await s.act({ action: "click" }, f.owner.signal);
        expect(f.calls).toEqual([
            "check:view",
            "open",
            "check:view",
            "check:view",
            "observe",
            "check:view",
            "check:view",
            "navigate",
            "check:view",
            "check:control",
            "act",
            "check:control",
        ]);
    } finally {
        await s.close();
    }
    await s.closed;
    await s.close();
    expect(f.calls.slice(-3)).toEqual(["abort", "close", "release"]);
    expect(s.signal.aborted).toBe(true);
    expect(f.calls.filter((x) => x === "close")).toHaveLength(1);
});

test("denied startup releases a claim without creating a browser", async () => {
    const f = fixture();
    f.deny();
    await rejects(f.start(), /Browser access stopped/);
    expect(f.calls).toEqual(["check:view", "release"]);
});

test("invalid or stale permits never authorize startup", async () => {
    for (const value of [0, -1, 1.5, 5001, Number.NaN]) {
        const f = fixture();
        f.permits(value);
        await rejects(f.start(), /Browser access stopped/);
        expect(f.calls).not.toContain("open");
    }
    const f = fixture(),
        delayed = Promise.withResolvers<{ validForMs: number }>();
    f.holdCheck(delayed.promise);
    const starting = f.start();
    await Bun.sleep(30);
    delayed.resolve({ validForMs: 10 });
    await rejects(starting, /Browser access stopped/);
    expect(f.calls).not.toContain("open");
});

test("expired authority aborts startup even when its next check hangs", async () => {
    const f = fixture(),
        opened = Promise.withResolvers<Port>();
    f.permits(80);
    f.holdOpen(opened.promise);
    const starting = f.start();
    const failed = rejects(starting, /Browser access stopped/);
    await until(() => f.calls.includes("open"));
    f.holdCheck(new Promise(() => {}));
    await until(() => f.calls.includes("abort"));
    expect(f.calls).not.toContain("release");
    opened.resolve(f.port);
    await failed;
    expect(f.calls.slice(-2)).toEqual(["close", "release"]);
});

test("idle revocation and runtime disconnect both retire without waiting for another command", async () => {
    for (const cause of ["permission", "runtime"]) {
        const f = fixture();
        f.permits(100);
        const s = await f.start();
        if (cause === "permission") f.deny();
        else f.runtime.abort();
        await s.closed;
        expect(s.signal.aborted).toBe(true);
        expect(f.calls.slice(-2)).toEqual(["close", "release"]);
        await rejects(s.observe(f.owner.signal), /Browser access stopped/);
        expect(f.calls).not.toContain("observe");
    }
});

test("post-operation revocation discards content and never replays input", async () => {
    for (const mode of ["observe", "act"]) {
        const f = fixture(),
            image = Promise.withResolvers<typeof frame>(),
            input = Promise.withResolvers<{ effect: "unverified" }>();
        f.holdObserve(image.promise);
        f.holdAct(input.promise);
        const s = await f.start();
        const pending =
            mode === "observe"
                ? s.observe(f.owner.signal)
                : s.act({ action: "click" }, f.owner.signal);
        const failed = rejects(pending, /Do not replay input/);
        await until(() => f.calls.includes(mode));
        f.deny();
        image.resolve(frame);
        input.resolve({ effect: "unverified" });
        await failed;
        expect(f.calls.filter((x) => x === mode)).toHaveLength(1);
        expect(f.calls.slice(-2)).toEqual(["close", "release"]);
    }
});

test("operation cancellation denies a late result and waits for actual cleanup", async () => {
    const f = fixture(),
        operation = new AbortController(),
        image = Promise.withResolvers<typeof frame>(),
        cleanup = Promise.withResolvers<void>();
    f.holdObserve(image.promise);
    f.holdClose(cleanup.promise);
    const s = await f.start();
    const pending = s.observe(operation.signal),
        failed = rejects(pending, /Browser access stopped/);
    await until(() => f.calls.includes("observe"));
    operation.abort();
    await until(() => f.calls.includes("close"));
    expect(f.calls).not.toContain("release");
    image.resolve(frame);
    cleanup.resolve();
    await failed;
    expect(f.calls.at(-1)).toBe("release");
});

test("an unconfirmed factory failure retains the claim", async () => {
    const f = fixture();
    f.holdOpen(Promise.reject(new Error("private initialization output")));
    await rejects(f.start(), /cleanup could not be confirmed/);
    expect(f.calls).not.toContain("release");
});

test("cleanup and release failures stay sticky and never dispatch again", async () => {
    for (const cause of ["cleanup", "release"]) {
        const f = fixture(),
            s = await f.start();
        if (cause === "cleanup") f.failCleanup();
        else f.failRelease();
        await rejects(s.close(), /cleanup could not be confirmed/);
        await rejects(s.close(), /cleanup could not be confirmed/);
        await rejects(s.closed, /cleanup could not be confirmed/);
        await rejects(s.observe(f.owner.signal), /cleanup could not be confirmed/);
        expect(f.calls.filter((x) => x === "close")).toHaveLength(1);
        expect(f.calls.filter((x) => x === "release")).toHaveLength(
            cause === "cleanup" ? 0 : 1
        );
        expect(f.calls).not.toContain("observe");
    }
});

test("host cancellation before startup never creates a browser", async () => {
    const f = fixture();
    f.owner.abort();
    await rejects(f.start(), /Browser access stopped/);
    expect(f.calls).toEqual(["release"]);
});

test("overlapping commands are denied and pending input cannot be mutated", async () => {
    const f = fixture(),
        wait = Promise.withResolvers<{ validForMs: number }>(),
        s = await f.start();
    f.holdCheck(wait.promise);
    const input = { text: "approved" },
        pending = s.act(input, f.owner.signal);
    input.text = "changed";
    await rejects(s.observe(f.owner.signal), /active operation/);
    wait.resolve({ validForMs: 5000 });
    await pending;
    expect(f.input()).toEqual({ text: "approved" });
    expect(f.calls).not.toContain("observe");
    await s.close();
});

test("a disconnect while binding the native signal cannot be missed", async () => {
    const f = fixture();
    let reads = 0;
    Object.defineProperty(f.port, "signal", {
        get: () => {
            if (++reads === 2) f.runtime.abort();
            return f.runtime.signal;
        },
    });
    await rejects(f.start(), /Browser access stopped/);
    expect(f.calls.slice(-2)).toEqual(["close", "release"]);
});

test("successful idle checks cannot renew a hung operation check", async () => {
    const f = fixture();
    f.permits(120);
    const original = f.access.check;
    f.access.check = (mode) =>
        mode === "control" ? new Promise(() => {}) : original(mode);
    const session = await f.start();
    const pending = rejects(
        session.act({ action: "click" }, f.owner.signal),
        /Browser access stopped/
    );
    try {
        await until(() => session.signal.aborted);
        await pending;
        expect(f.calls.filter((x) => x === "check:view").length).toBeGreaterThan(2);
        expect(f.calls).not.toContain("act");
        expect(f.calls.slice(-2)).toEqual(["close", "release"]);
    } finally {
        await session.close();
    }
});
