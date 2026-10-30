import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";

import { createVisualChallenge } from "../testing/visualChallenge";
import { openNativeBrowser } from "./native";
import { browserGrant, browserManifest, browserUrl } from "./policy";
import { browserMetadata, browserSnapshot, type BrowserNativeResult } from "./protocol";

const signal = () => new AbortController().signal;
const origin = "https://fixture.invalid";
const target = { targetId: "target", tabId: "tab", origins: [origin] };
function snapshot() {
    return {
        status: "ok",
        mode: "snapshot",
        target_id: "target",
        tab_id: "tab",
        page: { url: `${origin}/`, title: "Synthetic browser" },
        snapshot: { id: "p1", format: "semantic_v2", complete: true },
        outline: "Untrusted fixture text",
        refs: [
            {
                ref: "p1:0",
                role: "textbox",
                name: "Entry",
                actions: ["type", "pointer"],
                frame: "main",
                visibility: "in_viewport",
                states: {},
            },
            {
                ref: "p1:1",
                role: "button",
                name: "Count",
                actions: ["click"],
                frame: "main",
                visibility: "in_viewport",
                states: {},
            },
        ],
        screenshot: {
            source: "cdp_tab",
            scope: "viewport",
            mime_type: "image/png",
            width: 390,
            height: 110,
        },
    };
}
function response(
    data: unknown,
    images: BrowserNativeResult["images"] = []
): BrowserNativeResult {
    return { isError: false, structuredJson: JSON.stringify(data), images };
}
const image = () => ({ mimeType: "image/png", dataBase64: createVisualChallenge().data });
async function fixture(uploads = false, downloads = false) {
    const grant = {
        executable: await realpath(process.execPath),
        origins: [origin],
        initialUrl: `${origin}/`,
        mode: "control" as "view" | "control",
        ...(uploads ? { uploads: true as const } : {}),
        ...(downloads ? { downloads: true as const } : {}),
    };
    const owner = new AbortController();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let manifest = "",
        shuts = 0,
        time = 0;
    const results: Record<string, BrowserNativeResult> = {
        browser_prepare: response({
            status: "ok",
            prepared: true,
            action: "launched_isolated_browser",
            prepared_pid: 123,
            endpoint_ownership: { method: "spawned_by_driver", owner_pid: 123 },
            lifecycle: {
                owner: "session",
                process_ends_with_session: true,
                profile_persists_after_session: false,
            },
        }),
        list_windows: response({ windows: [{ pid: 123, window_id: 456 }] }),
        bind: response({
            status: "ok",
            mode: "bind",
            binding_quality: "exact",
            endpoint_access_class: "driver_owned",
            mutation_allowed: true,
            target_id: "target",
            tabs: [{ tab_id: "tab", url: "about:blank" }],
        }),
        get_browser_state: response(snapshot(), [image()]),
        browser_navigate: response({
            status: "ok",
            target_id: "target",
            tab_id: "tab",
            url: `${origin}/`,
            refs_invalidated: true,
        }),
        browser_type: response({
            effect: "unverifiable",
            route: "trusted_input",
            delivery: { mode: "background" },
        }),
        browser_click: response({
            effect: "unverifiable",
            route: "trusted_input",
            delivery: { mode: "foreground" },
        }),
    };
    const native = {
        callTool: (
            name: string,
            args: Record<string, unknown>,
            _signal?: AbortSignal
        ) => {
            calls.push({ name, args });
            return Promise.resolve(
                results[name === "get_browser_state" && args.pid ? "bind" : name]!
            );
        },
        shutdown: () => {
            shuts++;
            return Promise.resolve();
        },
    };
    return {
        grant,
        owner,
        calls,
        native,
        results,
        open: () =>
            openNativeBrowser(
                grant,
                owner.signal,
                (file) => {
                    manifest = file;
                    return Promise.resolve(native);
                },
                () => time
            ),
        time: (next: number) => {
            time = next;
        },
        manifest: () => manifest,
        shuts: () => shuts,
    };
}

test("browser policy admits exact web origins and no model-selected profiles or native tools", async () => {
    const f = await fixture();
    const valid = browserGrant(f.grant);
    f.grant.origins.push("https://later.invalid");
    expect(valid.origins).toEqual([origin]);
    expect(browserUrl(`${origin}/path?q=1`, valid.origins)).toBe(`${origin}/path?q=1`);
    const manifest = browserManifest(valid);
    expect(manifest.resources.browser).toEqual({
        profiles: [{ kind: "isolated" }],
        origins: ["about:blank", origin],
    });
    expect(manifest.resources.desktop).toEqual({ display: false });
    expect(manifest.allow.tools).not.toContain("get_window_state");
    expect(manifest.allow.tools).not.toContain("browser_evaluate");
    expect(browserManifest({ ...valid, mode: "view" }).allow.tools).not.toContain(
        "browser_click"
    );
    for (const bad of [
        "file:///tmp/a",
        "javascript:alert(1)",
        "about:blank",
        "https://fixture.invalid.evil/",
        "https://fixture.invalid:444/",
        "http://fixture.invalid/",
        "https://user:pass@fixture.invalid/",
        " https://fixture.invalid/",
        String.raw`https://fixture.invalid\x`,
        `${origin}/\uD800`,
    ])
        expect(() => browserUrl(bad, valid.origins)).toThrow();
    for (const patch of [
        { executable: "relative" },
        { origins: [origin, origin] },
        { origins: [`${origin}/`] },
        { origins: ["https://FIXTURE.invalid"] },
        { origins: ["*"] },
        { profile: "existing" },
        { initialUrl: "https://other.invalid/" },
    ])
        expect(() => browserGrant({ ...valid, ...patch })).toThrow();
});

test("native upload grants are opt-in and bind the file reader to one origin and private staging root", async () => {
    const f = await fixture();
    const manifest = browserManifest(f.grant);
    expect(manifest.allow.tools).not.toContain("browser_set_input_files");
    expect(manifest.resources).not.toHaveProperty("files");
    for (const input of [
        { ...f.grant, uploads: true, mode: "view" },
        { ...f.grant, uploads: true, origins: [origin, "https://other.invalid"] },
    ])
        expect(() => browserGrant(input)).toThrow();
    expect(() => browserManifest({ ...f.grant, uploads: true })).toThrow();
    expect(() => browserManifest(f.grant, "/tmp/staged")).toThrow();
    expect(() => browserManifest({ ...f.grant, uploads: true }, "relative")).toThrow();
});

test("native uploads consume one fresh file ref, disclose no paths, and remove staged bytes on close", async () => {
    const f = await fixture(true);
    const data = snapshot();
    data.refs[0] = { ...data.refs[0]!, role: "file", actions: ["upload"] };
    f.results.get_browser_state = response(data, [image()]);
    f.results.browser_set_input_files = response({
        status: "ok",
        target_id: "target",
        tab_id: "tab",
        ref: "p1:0",
        frame: "main",
        file_count: 1,
    });
    const browser = await f.open();
    const bytes = new TextEncoder().encode("Exact approved content");
    const file = {
        name: "report.txt",
        bytes,
        size: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    };
    const frame = await browser.observe(signal());
    const command = { observationId: frame.observationId, ref: "p1:0" };
    expect(await browser.upload(command, file, signal())).toEqual({
        effect: "unverified",
    });
    const call = f.calls.find((item) => item.name === "browser_set_input_files")!;
    const [staged] = call.args.files as string[];
    expect(await Bun.file(staged!).text()).toBe("Exact approved content");
    const manifest = (await Bun.file(f.manifest()).json()) as {
        allow: { tools: string[] };
        resources: { files: { read: { dir: string }[]; write?: unknown } };
    };
    expect(manifest.allow.tools).toContain("browser_set_input_files");
    expect(manifest.resources.files.write).toBeUndefined();
    expect(
        staged!.startsWith(manifest.resources.files.read[0]!.dir + "/") ||
            staged!.startsWith(manifest.resources.files.read[0]!.dir + "\\")
    ).toBe(true);
    await assert.rejects(browser.upload(command, file, signal()), /fresh file-input/);
    expect(
        f.calls.filter((item) => item.name === "browser_set_input_files")
    ).toHaveLength(1);
    await browser.close();
    expect(await Bun.file(staged!).exists()).toBe(false);
});

test("native upload refusals retire the session without dispatching unapproved bytes", async () => {
    for (const scenario of [
        "disabled",
        "expired",
        "wrong-ref",
        "wrong-observation",
        "digest",
        "extra-path",
        "refused",
        "response-tab",
        "response-ref",
        "response-image",
        "cancelled",
    ]) {
        const f = await fixture(scenario !== "disabled");
        const data = snapshot();
        data.refs[0] = { ...data.refs[0]!, actions: ["upload"] };
        f.results.get_browser_state = response(data, [image()]);
        f.results.browser_set_input_files = response(
            {
                status: "ok",
                target_id: "target",
                tab_id: scenario === "response-tab" ? "other" : "tab",
                ref: scenario === "response-ref" ? "p1:1" : "p1:0",
                frame: "main",
                file_count: 1,
            },
            scenario === "response-image" ? [image()] : []
        );
        if (scenario === "refused") f.results.browser_set_input_files.isError = true;
        const browser = await f.open();
        const frame = await browser.observe(signal());
        if (scenario === "disabled")
            expect(frame.refs.some((item) => item.actions.includes("upload"))).toBe(
                false
            );
        if (scenario === "expired") f.time(10_000);
        const bytes = new Uint8Array([1]);
        const file = {
            name: "test.txt",
            bytes,
            size: 1,
            sha256:
                scenario === "digest"
                    ? "0".repeat(64)
                    : new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        };
        const operation = new AbortController();
        if (scenario === "cancelled") operation.abort();
        await assert.rejects(
            browser.upload(
                {
                    observationId:
                        scenario === "wrong-observation"
                            ? crypto.randomUUID()
                            : frame.observationId,
                    ref: scenario === "wrong-ref" ? "p1:1" : "p1:0",
                    ...(scenario === "extra-path" ? { path: "/private/secret" } : {}),
                },
                file,
                operation.signal
            )
        );
        if (
            !["refused", "response-tab", "response-ref", "response-image"].includes(
                scenario
            )
        )
            expect(f.calls.some((item) => item.name === "browser_set_input_files")).toBe(
                false
            );
        await assert.rejects(browser.observe(signal()));
        await browser.close();
        expect(await Bun.file(f.manifest()).exists()).toBe(false);
    }
});

test("dedicated browser binds an owned blank tab and dispatches only observed input", async () => {
    const f = await fixture();
    const browser = await f.open();
    const initial = f.calls.map((item) => item.name);
    expect(initial).toEqual([
        "browser_prepare",
        "list_windows",
        "get_browser_state",
        "browser_navigate",
    ]);
    expect(f.calls[0]!.args).toMatchObject({
        allow_launch: true,
        profile: { mode: "isolated_new" },
    });
    expect(f.calls[1]!.args.pid).toBe(123);
    expect(f.calls[2]!.args).toMatchObject({ pid: 123, window_id: 456 });
    const observed = await browser.observe(signal());
    expect(observed).toMatchObject({
        width: 390,
        height: 110,
        url: `${origin}/`,
        refs: [{ actions: ["type"] }, { actions: ["click"] }],
    });
    expect(
        await browser.act(
            {
                action: "type",
                observationId: observed.observationId,
                ref: "p1:0",
                text: "literal",
                replace: true,
            },
            signal()
        )
    ).toEqual({ effect: "unverified" });
    expect(f.calls.at(-1)).toMatchObject({
        name: "browser_type",
        args: {
            target_id: "target",
            tab_id: "tab",
            ref: "p1:0",
            text: "literal",
            replace: true,
            mode: "insert_text",
        },
    });
    const next = await browser.observe(signal());
    await browser.act(
        { action: "click", observationId: next.observationId, ref: "p1:1" },
        signal()
    );
    expect(f.calls.at(-1)).toMatchObject({
        name: "browser_click",
        args: { input_route: "trusted", delivery_mode: "foreground" },
    });
    expect(await browser.navigate(`${origin}/next`, signal())).toEqual({
        url: `${origin}/`,
    });
    await Promise.all([browser.close(), browser.close()]);
    expect(f.shuts()).toBe(1);
    expect(await Bun.file(f.manifest()).exists()).toBe(false);
    await assert.rejects(browser.observe(signal()), /stopped/);
});

test("view-only, forged, stale, reused and mismatched action references never dispatch", async () => {
    for (const scenario of [
        "view",
        "forged",
        "expired",
        "backwards",
        "reuse",
        "action",
        "text",
        "navigation",
        "new-snapshot",
    ]) {
        const f = await fixture();
        if (scenario === "view") f.grant.mode = "view";
        const browser = await f.open();
        const frame = await browser.observe(signal());
        const command = {
            action: "click",
            observationId: frame.observationId,
            ref: "p1:1",
        };
        if (scenario === "forged") command.ref = "p1:999";
        if (scenario === "expired") f.time(10_001);
        if (scenario === "backwards") f.time(-1);
        if (scenario === "reuse") await browser.act(command, signal());
        if (scenario === "action") command.ref = "p1:0";
        if (scenario === "navigation") await browser.navigate(`${origin}/next`, signal());
        if (scenario === "new-snapshot") await browser.observe(signal());
        const before = f.calls.length;
        await assert.rejects(
            browser.act(
                scenario === "text"
                    ? {
                          action: "type",
                          observationId: frame.observationId,
                          ref: "p1:0",
                          text: "\0",
                          replace: true,
                      }
                    : command,
                signal()
            )
        );
        expect(f.calls).toHaveLength(before);
        await browser.close();
    }
});

test("startup refuses unexpected process, profile, window and tab identities with cleanup", async () => {
    for (const scenario of [
        "owner",
        "profile",
        "window",
        "multiple",
        "binding",
        "tab",
        "navigation",
        "refused",
    ]) {
        const f = await fixture();
        if (scenario === "owner" || scenario === "profile") {
            const prepared = JSON.parse(f.results.browser_prepare!.structuredJson!) as {
                endpoint_ownership: { owner_pid: number };
                lifecycle: { profile_persists_after_session: boolean };
            };
            if (scenario === "owner") prepared.endpoint_ownership.owner_pid = 999;
            else prepared.lifecycle.profile_persists_after_session = true;
            f.results.browser_prepare = response(prepared);
        }
        if (scenario === "window")
            f.results.list_windows = response({
                windows: [{ pid: 999, window_id: 456 }],
            });
        if (scenario === "multiple")
            f.results.list_windows = response({
                windows: [
                    { pid: 123, window_id: 456 },
                    { pid: 123, window_id: 789 },
                ],
            });
        if (scenario === "binding")
            f.results.bind = response({ status: "ok", binding_quality: "heuristic" });
        if (scenario === "tab")
            f.results.bind!.structuredJson = f.results.bind!.structuredJson!.replace(
                "about:blank",
                `${origin}/existing`
            );
        if (scenario === "navigation")
            f.results.browser_navigate!.structuredJson =
                f.results.browser_navigate!.structuredJson!.replace(
                    '"target"',
                    '"other"'
                );
        if (scenario === "refused") f.results.browser_prepare!.isError = true;
        await assert.rejects(f.open());
        expect(f.shuts()).toBe(1);
        expect(await Bun.file(f.manifest()).exists()).toBe(false);
    }
});

test("out-of-scope navigation, redirected snapshots and action failures retire authority", async () => {
    for (const scenario of ["navigate", "redirect", "action-refused", "action-route"]) {
        const f = await fixture();
        const browser = await f.open();
        const frame = await browser.observe(signal());
        if (scenario === "navigate") {
            const before = f.calls.length;
            await assert.rejects(browser.navigate("https://other.invalid/", signal()));
            expect(f.calls).toHaveLength(before);
        } else if (scenario === "redirect") {
            const data = snapshot();
            data.page.url = "https://other.invalid/";
            f.results.get_browser_state = response(data, [image()]);
            await assert.rejects(browser.observe(signal()), /origin/);
        } else {
            if (scenario === "action-refused") f.results.browser_click!.isError = true;
            else
                f.results.browser_click!.structuredJson =
                    f.results.browser_click!.structuredJson!.replace(
                        "trusted_input",
                        "dom"
                    );
            await assert.rejects(
                browser.act(
                    { action: "click", observationId: frame.observationId, ref: "p1:1" },
                    signal()
                )
            );
        }
        await assert.rejects(browser.observe(signal()), /stopped/);
        await browser.close();
        expect(f.shuts()).toBe(1);
    }
});

test("idle and absolute expiry stop a browser even when the driver would still accept calls", async () => {
    for (const total of [false, true]) {
        const f = await fixture();
        const browser = await f.open();
        if (total)
            for (let tick = 1; tick <= 5; tick++) {
                f.time(tick * 50_000);
                await browser.observe(signal());
            }
        f.time(total ? 300_000 : 60_000);
        const before = f.calls.length;
        await assert.rejects(browser.observe(signal()), /expired/);
        expect(f.calls).toHaveLength(before);
        await browser.close();
    }
});

test("concurrent calls are rejected and cancellation discards a late native frame", async () => {
    const f = await fixture();
    const browser = await f.open();
    const pending = Promise.withResolvers<BrowserNativeResult>();
    f.native.callTool = () => pending.promise;
    const read = browser.observe(signal());
    await assert.rejects(browser.observe(signal()), /active call/);
    f.owner.abort();
    pending.resolve(response(snapshot(), [image()]));
    await assert.rejects(read);
    await browser.close();
    expect(f.shuts()).toBe(1);
});

test("operation cancellation and native cleanup failures cannot reopen the browser", async () => {
    const f = await fixture();
    const browser = await f.open();
    const abort = new AbortController();
    f.native.callTool = () => {
        abort.abort();
        return Promise.resolve(response(snapshot(), [image()]));
    };
    await assert.rejects(browser.observe(abort.signal));
    await browser.close();
    const second = await fixture();
    const other = await second.open();
    second.native.shutdown = () => Promise.reject(new Error("cleanup failed"));
    await assert.rejects(other.close(), /cleanup failed/);
    await assert.rejects(other.close(), /cleanup failed/);
    expect(await Bun.file(second.manifest()).exists()).toBe(false);
});

test("browser protocol bounds pixels, metadata and exact current document references", () => {
    for (const scenario of [
        "metadata",
        "mime",
        "encoding",
        "size",
        "multiple",
        "target",
        "ref",
        "duplicate",
        "source",
    ]) {
        const data = snapshot();
        const result = response(data, [image()]);
        if (scenario === "metadata") result.structuredJson = "x".repeat(256 * 1024 + 1);
        if (scenario === "mime") result.images[0]!.mimeType = "image/svg+xml";
        if (scenario === "encoding")
            result.images[0]!.dataBase64 = "https://invalid/image.png";
        if (scenario === "size") data.screenshot.width = 999;
        if (scenario === "multiple") result.images.push(image());
        if (scenario === "target") data.tab_id = "wrong";
        if (scenario === "ref") data.refs[0]!.ref = "p2:0";
        if (scenario === "duplicate") data.refs.push(data.refs[0]!);
        if (scenario === "source") data.screenshot.source = "desktop";
        if (scenario !== "metadata") result.structuredJson = JSON.stringify(data);
        expect(() => browserSnapshot(result, target)).toThrow();
    }
    expect(() => browserMetadata({ isError: false, images: [] })).toThrow();
    const data = snapshot();
    data.refs.push(
        { ...data.refs[0]!, ref: "p1:2", frame: "child" },
        { ...data.refs[0]!, ref: "p1:3", visibility: "offscreen" },
        { ...data.refs[0]!, ref: "p1:4", states: { disabled: true } }
    );
    expect(browserSnapshot(response(data, [image()]), target).refs).toHaveLength(2);
});

test("operator observations allow manual entry without extending model refs or allowing reuse", async () => {
    for (const operator of [false, true]) {
        const f = await fixture();
        const browser = await f.open();
        try {
            const frame = await browser.observe(signal(), operator);
            f.time(30_000);
            const command = {
                action: "click",
                observationId: frame.observationId,
                ref: "p1:1",
            };
            if (operator) {
                expect(await browser.act(command, signal())).toEqual({
                    effect: "unverified",
                });
                await assert.rejects(browser.act(command, signal()));
            } else await assert.rejects(browser.act(command, signal()));
        } finally {
            await browser.close();
        }
    }
});

test("native downloads require explicit authority, operator link refs and one unused observation", async () => {
    for (const scenario of [
        "disabled",
        "model",
        "stale",
        "ref",
        "image",
        "success",
    ] as const) {
        const f = await fixture(false, scenario !== "disabled");
        const data = snapshot();
        data.refs[1]!.role = "link";
        f.results.get_browser_state = response(data, [image()]);
        const dispatch = f.native.callTool;
        f.native.callTool = async (name, args, operation) => {
            if (name !== "browser_download") return dispatch(name, args, operation);
            const id = "01a1fc90-473e-7500-8102-010203040506";
            await Bun.write(String(args.destination_root) + "/" + id, "hello");
            f.calls.push({ name, args });
            return response(
                { status: "completed", download_id: id, bytes: 5 },
                scenario === "image" ? [image()] : []
            );
        };
        const browser = await f.open();
        const frame = await browser.observe(signal(), scenario !== "model");
        if (scenario === "stale") f.time(60_000);
        const command = {
            observationId: frame.observationId,
            ref: scenario === "ref" ? "p1:0" : "p1:1",
        };
        if (scenario === "success") {
            const result = await browser.download(command, signal());
            expect(result.bytes.toString()).toBe("hello");
            await assert.rejects(browser.download(command, signal()));
        } else await assert.rejects(browser.download(command, signal()));
        expect(f.calls.filter((call) => call.name === "browser_download")).toHaveLength(
            ["success", "image"].includes(scenario) ? 1 : 0
        );
        await browser.close();
    }
});
