import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import {
    hereNowBinding,
    hereNowBindingHash,
    hereNowReadConfiguration,
} from "./configuration";
import { HereNowReader } from "./reader";
const configuration = {
    owner: "operator",
    accountId: "11111111-1111-4111-8111-111111111111",
    apiKey: "synthetic-provider-key",
};
const account = {
    accountId: configuration.accountId,
    type: "personal",
    displayName: "Mira",
    status: "active",
    provisioningStatus: "active",
    role: "admin",
} as const;
const signal = new AbortController().signal;
const site = {
    slug: "sample-site",
    status: "active",
    currentVersionId: "live-one",
    pendingVersionId: null,
    updatedAt: "2026-10-25T00:00:00Z",
    expiresAt: null,
};

test("here.now requires an immutable account mapping independent of credential rotation", () => {
    expect(hereNowReadConfiguration({})).toBeUndefined();
    expect(() =>
        hereNowReadConfiguration({ HOMELAB_MIRA_HERENOW_API_KEY: configuration.apiKey })
    ).toThrow(/explicit/);
    const environment = {
        HOMELAB_MIRA_HERENOW_OWNER: configuration.owner,
        HOMELAB_MIRA_HERENOW_ACCOUNT_ID: configuration.accountId,
    };
    expect(hereNowBinding(environment)).toEqual({
        owner: configuration.owner,
        accountId: configuration.accountId,
    });
    expect(
        hereNowReadConfiguration({
            ...environment,
            HOMELAB_MIRA_HERENOW_API_KEY: configuration.apiKey,
        })
    ).toEqual(configuration);
    const rotated = { ...configuration, apiKey: "rotated" };
    expect(hereNowBindingHash(configuration)).toBe(hereNowBindingHash(rotated));
    expect(() =>
        hereNowBinding({
            ...environment,
            HOMELAB_MIRA_HERENOW_ACCOUNT_ID: "a-workspace-name",
        })
    ).toThrow();
});

test("here.now metadata reads pin account and origin and omit provider secrets and foreign sites", async () => {
    const seen: { url: string; init: Parameters<typeof fetch>[1] }[] = [];
    const request = Object.assign(
        (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            if (typeof url !== "string") throw new Error("Expected fixed URL");
            seen.push({ url, init });
            if (url.endsWith("accounts"))
                return Promise.resolve(
                    Response.json({
                        currentAccountId: configuration.accountId,
                        accounts: [
                            {
                                ...account,
                                apiKey: "must-not-return",
                                billing: { card: "private" },
                            },
                            {
                                ...account,
                                accountId: "22222222-2222-4222-8222-222222222222",
                                displayName: "Foreign",
                            },
                        ],
                    })
                );
            if (url.endsWith("publishes"))
                return Promise.resolve(
                    Response.json({
                        publishes: Array.from({ length: 51 }, (_, i) => ({
                            ...site,
                            slug: `site-${i}`,
                            claimToken: "private",
                            siteUrl: "https://untrusted.example/",
                        })),
                    })
                );
            if (url.endsWith("access"))
                return Promise.resolve(
                    Response.json({
                        access: {
                            mode: "restricted",
                            accessPolicyVersion: 3,
                            allowedEmails: ["guest@example.test"],
                            allowedDomains: [],
                            password: "must-not-return",
                        },
                        notifications: { secret: "must-not-return" },
                    })
                );
            return Promise.resolve(
                Response.json({
                    ...site,
                    displayName: "Preview",
                    currentVersionSource: "editor",
                    currentVersionCreatedAt: site.updatedAt,
                    manifest: Array.from({ length: 101 }, (_, i) => ({
                        path: `file-${i}.txt`,
                        size: 5,
                        contentType: "text/plain",
                        downloadUrl: "https://untrusted.example/",
                    })),
                    claimToken: "must-not-return",
                })
            );
        },
        { preconnect: fetch.preconnect }
    );
    const reader = new HereNowReader(configuration, request);
    const selected = await reader.account(signal);
    expect(selected).toEqual(account);
    const list = await reader.sites(signal);
    expect(list.sites).toHaveLength(50);
    expect(list.truncated).toBe(true);
    expect(list.sites[0]?.url).toBe("https://site-0.here.now/");
    const details = await reader.site("sample-site", signal);
    expect(details.currentVersionId).toBe("live-one");
    expect(details.currentVersionSource).toBe("editor");
    expect(details.manifest).toHaveLength(100);
    expect(details.manifestTruncated).toBe(true);
    expect(details.access).toEqual({
        mode: "restricted",
        accessPolicyVersion: 3,
        allowedEmails: ["guest@example.test"],
        allowedDomains: [],
    });
    expect(JSON.stringify({ selected, list, details })).not.toContain("must-not-return");
    expect(JSON.stringify(details)).not.toContain("downloadUrl");
    for (const item of seen) {
        const url = new URL(item.url);
        expect(url.origin).toBe("https://here.now");
        expect(url.search).toBe("");
        expect(item.init).toMatchObject({
            method: "GET",
            credentials: "omit",
            redirect: "error",
        });
        const headers = new Headers(item.init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${configuration.apiKey}`);
        expect(headers.get("x-herenow-account")).toBe(configuration.accountId);
        expect(headers.get("x-herenow-client")).toBe("homelab/mira");
    }
    const count = seen.length;
    await rejects(reader.site("../me/keys", signal));
    expect(seen).toHaveLength(count);
});

for (const change of [
    "selector",
    "selection",
    "membership",
    "suspended",
    "duplicate",
] as const)
    test(`here.now rejects ${change} account disagreement before reading sites`, async () => {
        let calls = 0;
        let accounts = [
            { ...account, status: change === "suspended" ? "suspended" : "active" },
        ];
        if (change === "membership") accounts = [];
        if (change === "duplicate") accounts = [account, account];
        const body = {
            currentAccountId:
                change === "selection"
                    ? "22222222-2222-4222-8222-222222222222"
                    : configuration.accountId,
            accounts,
            selectorError: change === "selector" ? { code: "forbidden" } : null,
        };
        const request = Object.assign(
            () => {
                calls++;
                return Promise.resolve(Response.json(body));
            },
            { preconnect: fetch.preconnect }
        );
        await rejects(new HereNowReader(configuration, request).sites(signal));
        expect(calls).toBe(1);
    });

test("here.now rejects a different site and unknown access modes without fetching file bytes", async () => {
    let wrong = true;
    const request = Object.assign(
        (url: Parameters<typeof fetch>[0]) => {
            if (typeof url !== "string") throw new Error("Expected URL");
            if (url.endsWith("accounts"))
                return Promise.resolve(
                    Response.json({
                        currentAccountId: configuration.accountId,
                        accounts: [account],
                    })
                );
            if (url.endsWith("access"))
                return Promise.resolve(
                    Response.json({
                        access: {
                            mode: "future-unknown",
                            accessPolicyVersion: 1,
                            allowedEmails: [],
                            allowedDomains: [],
                        },
                    })
                );
            return Promise.resolve(
                Response.json({
                    ...site,
                    slug: wrong ? "other-site" : site.slug,
                    currentVersionSource: null,
                    currentVersionCreatedAt: null,
                    manifest: [],
                })
            );
        },
        { preconnect: fetch.preconnect }
    );
    const reader = new HereNowReader(configuration, request);
    await rejects(reader.site(site.slug, signal), /different site/);
    wrong = false;
    await rejects(reader.site(site.slug, signal));
    const abort = new AbortController();
    abort.abort();
    await rejects(reader.account(abort.signal));
});

for (const response of [
    () => new Response("private", { status: 401 }),
    () => new Response("{}", { headers: { "content-length": "3000000" } }),
    () => new Response("invalid"),
])
    test("here.now rejects unsuccessful and invalid bounded responses", async () => {
        const request = Object.assign(() => Promise.resolve(response()), {
            preconnect: fetch.preconnect,
        });
        await rejects(new HereNowReader(configuration, request).account(signal));
    });
