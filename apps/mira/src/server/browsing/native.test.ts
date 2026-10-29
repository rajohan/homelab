import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";

import type * as NativeSdk from "@trycua/cua-driver";

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
async function fixture() {
    const grant = {
        executable: await realpath(process.execPath),
        origins: [origin],
        initialUrl: `${origin}/`,
        mode: "control" as "view" | "control",
    };
    const owner = new AbortController();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let manifest = "",
        shuts = 0,
        destroys = 0,
        time = 0;
    const metadata = { driverVersion: "0.37.0", embedded: true };
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
        metadata: () => Promise.resolve(metadata),
        startSession: () => Promise.resolve(),
        callTool: (name: string, input: string, _options?: { signal?: AbortSignal }) => {
            const args = JSON.parse(input) as Record<string, unknown>;
            calls.push({ name, args });
            return Promise.resolve(
                results[name === "get_browser_state" && args.pid ? "bind" : name]!
            );
        },
        shutdown: () => {
            shuts++;
            return Promise.resolve();
        },
        uniffiDestroy: () => {
            destroys++;
        },
    };
    const sdk = {
        CuaDriver: {
            instanceOf: () => true,
            createConfigured: (input: {
                authorization: {
                    compatibilityCapabilityManifestPath: string;
                    unrestrictedAcknowledged: boolean;
                };
            }) => {
                manifest = input.authorization.compatibilityCapabilityManifestPath;
                expect(input.authorization.unrestrictedAcknowledged).toBe(false);
                return native;
            },
        },
        SessionPermissionMode: { Bounded: 1 },
    } as unknown as typeof NativeSdk;
    return {
        grant,
        owner,
        calls,
        native,
        metadata,
        results,
        open: () =>
            openNativeBrowser(
                grant,
                owner.signal,
                () => Promise.resolve(sdk),
                () => time
            ),
        time: (next: number) => {
            time = next;
        },
        manifest: () => manifest,
        shuts: () => shuts,
        destroys: () => destroys,
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
    expect(f.destroys()).toBe(1);
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

test("startup refuses unexpected SDK, process, profile, window and tab identities with cleanup", async () => {
    for (const scenario of [
        "version",
        "embedded",
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
        if (scenario === "version") f.metadata.driverVersion = "0.38.0";
        if (scenario === "embedded") f.metadata.embedded = false;
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
        expect(f.destroys()).toBe(1);
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
    expect(second.destroys()).toBe(1);
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
