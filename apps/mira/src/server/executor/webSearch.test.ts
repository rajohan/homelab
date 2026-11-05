import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { SQL } from "bun";

import { syntheticSearchTool } from "./webSearch";

test("Synthetic Chat searches with the bound subscription and returns bounded source excerpts", async () => {
    const config = { owner: "operator", apiKey: "synthetic-fixture-token" };
    const context = {
        owner: config.owner,
        actor: "mira:fixture",
        receiptId: "fixture",
        client: new SQL("postgres://fixture@localhost/unused"),
    };
    let available = true;
    const calls: string[] = [];
    const request: typeof fetch = Object.assign(
        (url: string | Request | URL, init?: RequestInit) => {
            const address = url instanceof Request ? url.url : url.toString();
            calls.push(address);
            expect(init?.redirect).toBe("error");
            expect(new Headers(init?.headers).get("authorization")).toBe(
                "Bearer " + config.apiKey
            );
            if (address === "https://api.synthetic.new/v2/quotas")
                return Promise.resolve(
                    Response.json({
                        subscription: { limit: 2, requests: available ? 0 : 2 },
                    })
                );
            expect(address).toBe("https://api.synthetic.new/v2/search");
            expect(init?.method).toBe("POST");
            expect(init?.body).toBe(JSON.stringify({ query: "latest release" }));
            return Promise.resolve(
                Response.json({
                    results: [
                        { url: "javascript:alert(1)", title: "invalid", text: "invalid" },
                        {
                            url: "https://unsafe:credential@example.org/",
                            title: "invalid",
                            text: "invalid",
                        },
                        {
                            url: "https://example.org/release",
                            title: "Release",
                            text: "x".repeat(2000),
                        },
                    ],
                })
            );
        },
        { preconnect: fetch.preconnect }
    );
    const tool = syntheticSearchTool(config, request);
    const signal = new AbortController().signal;
    await rejects(
        tool.action({ query: "hello" }, signal, { ...context, owner: "other" }),
        /account/
    );
    await rejects(tool.action({ query: "  " }, signal, context));
    expect(calls).toHaveLength(0);
    expect(await tool.action({ query: " latest release " }, signal, context)).toEqual([
        { url: "https://example.org/release", title: "Release", text: "x".repeat(1600) },
    ]);
    available = false;
    await rejects(
        tool.action({ query: "latest release" }, signal, context),
        /unavailable/
    );
    expect(calls).toEqual([
        "https://api.synthetic.new/v2/quotas",
        "https://api.synthetic.new/v2/search",
        "https://api.synthetic.new/v2/quotas",
    ]);
    await context.client.close();
});
