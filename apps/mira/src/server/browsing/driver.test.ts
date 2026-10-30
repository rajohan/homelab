import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    browserDriverVersion,
    normalizeBrowserResult,
    openBrowserDriver,
} from "./driver";
import type { BrowserDriverHost } from "./driverProcess";

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-mcp-test-"));
    const manifest = path.join(directory, "capabilities.json");
    await writeFile(
        manifest,
        JSON.stringify({
            allow: { tools: ["start_session", "end_session", "get_browser_state"] },
        })
    );
    const owner = new AbortController(),
        daemon = new AbortController(),
        rpc = new AbortController();
    const calls: { method: string; params: unknown }[] = [];
    let stops = 0,
        closes = 0;
    let initialize: unknown = {
        protocolVersion: "2025-06-18",
        serverInfo: { version: browserDriverVersion },
        capabilities: { tools: {} },
    };
    let result: unknown = { content: [], structuredContent: { status: "ok" } };
    let request = (method: string, params: unknown): Promise<unknown> => {
        calls.push({ method, params });
        return Promise.resolve(method === "initialize" ? initialize : result);
    };
    const host: BrowserDriverHost = {
        signal: daemon.signal,
        ready: () => Promise.resolve(),
        connect: () => ({
            signal: rpc.signal,
            request: (method, params) => request(method, params),
            notify: (method, params) => {
                calls.push({ method, params });
            },
            close: () => {
                closes++;
                rpc.abort();
                return Promise.resolve();
            },
        }),
        stop: () => {
            stops++;
            daemon.abort();
            return Promise.resolve();
        },
    };
    return {
        host,
        owner,
        daemon,
        rpc,
        calls,
        setResult: (value: unknown) => {
            result = value;
        },
        setInitialize: (value: unknown) => {
            initialize = value;
        },
        setRequest: (value: typeof request) => {
            request = value;
        },
        open: () =>
            openBrowserDriver(manifest, directory, owner.signal, () =>
                Promise.resolve(host)
            ),
        stops: () => stops,
        closes: () => closes,
        cleanup: () => rm(directory, { recursive: true, force: true }),
    };
}

test("official MCP binds one session, admits only manifest tools and ends both children", async () => {
    const f = await fixture();
    try {
        const driver = await f.open();
        const signal = new AbortController().signal;
        for (const [name, args] of [
            ["browser_evaluate", {}],
            ["start_session", {}],
            ["end_session", {}],
            ["get_browser_state", { session: "forged" }],
            ["get_browser_state", { _approved: true }],
        ] as const)
            await assert.rejects(driver.callTool(name, args, signal), /manifest/);
        const result = await driver.callTool(
            "get_browser_state",
            { tab_id: "tab" },
            signal
        );
        expect(result).toEqual({
            isError: false,
            structuredJson: '{"status":"ok"}',
            images: [],
        });
        await driver.shutdown();
        await driver.shutdown();
        expect(f.stops()).toBe(1);
        expect(f.closes()).toBe(1);
        const requests = f.calls
            .filter((call) => call.method === "tools/call")
            .map(
                (call) => call.params as { name: string; arguments: { session: string } }
            );
        expect(requests.map((call) => call.name)).toEqual([
            "start_session",
            "get_browser_state",
            "end_session",
        ]);
        expect(new Set(requests.map((call) => call.arguments.session)).size).toBe(1);
        await assert.rejects(driver.callTool("get_browser_state", {}, signal), /stopped/);
    } finally {
        await f.cleanup();
    }
});

test("MCP startup rejects version, protocol, missing tools, refusals and early cancellation", async () => {
    for (const scenario of [
        "version",
        "protocol",
        "tools",
        "refused",
        "owner",
        "daemon",
        "ready",
    ] as const) {
        const f = await fixture();
        try {
            if (["version", "protocol", "tools"].includes(scenario))
                f.setInitialize({
                    protocolVersion: scenario === "protocol" ? "old" : "2025-06-18",
                    serverInfo: {
                        version: scenario === "version" ? "0.0.0" : browserDriverVersion,
                    },
                    capabilities: scenario === "tools" ? {} : { tools: {} },
                });
            if (scenario === "refused")
                f.setResult({
                    isError: true,
                    content: [{ type: "text", text: "private diagnostic" }],
                });
            if (scenario === "owner")
                f.host.ready = () => {
                    f.owner.abort();
                    return Promise.resolve();
                };
            if (scenario === "daemon") f.daemon.abort();
            if (scenario === "ready")
                f.host.ready = () => Promise.reject(new Error("startup failed"));
            await assert.rejects(f.open());
            expect(f.stops()).toBe(1);
        } finally {
            await f.cleanup();
        }
    }
});

test("MCP owner, connection and operation cancellation permanently retire native authority", async () => {
    for (const reason of ["owner", "daemon", "rpc", "operation"] as const) {
        const f = await fixture();
        try {
            const driver = await f.open();
            const operation = new AbortController();
            if (reason === "operation") {
                f.setRequest(() => {
                    operation.abort();
                    return Promise.resolve({ content: [] });
                });
                await assert.rejects(
                    driver.callTool("get_browser_state", {}, operation.signal)
                );
            } else f[reason].abort();
            await driver.shutdown();
            expect(f.stops()).toBe(1);
            await assert.rejects(
                driver.callTool("get_browser_state", {}, new AbortController().signal)
            );
        } finally {
            await f.cleanup();
        }
    }
});

test("MCP cleanup still stops the daemon when end_session or RPC cleanup fails", async () => {
    const f = await fixture();
    try {
        const driver = await f.open();
        f.setRequest(() => Promise.reject(new Error("ended unexpectedly")));
        await assert.rejects(driver.shutdown(), /unexpectedly/);
        expect(f.stops()).toBe(1);
        await assert.rejects(driver.shutdown(), /unexpectedly/);
    } finally {
        await f.cleanup();
    }
});

test("MCP responses retain structured metadata and PNGs without copying text diagnostics", () => {
    expect(
        normalizeBrowserResult({ content: [{ type: "text", text: "private" }] })
    ).toEqual({ isError: false, images: [] });
    expect(
        normalizeBrowserResult({ isError: true, content: [], structuredContent: null })
    ).toEqual({ isError: true, structuredJson: "null", images: [] });
    expect(
        normalizeBrowserResult({
            content: [{ type: "image", mimeType: "image/png", data: "image" }],
        }).images
    ).toHaveLength(1);
    for (const value of [
        { content: [{ type: "image", mimeType: "image/svg+xml", data: "x" }] },
        { content: [], structuredContent: "x".repeat(256 * 1024) },
        { content: Array.from({ length: 17 }, () => ({ type: "text", text: "x" })) },
        { content: [{ type: "resource_link", uri: "file:///secret" }] },
    ])
        expect(() => normalizeBrowserResult(value)).toThrow();
});
