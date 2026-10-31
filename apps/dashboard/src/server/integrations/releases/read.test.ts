import { expect, test } from "bun:test";

import { readHomelabRelease } from "./read";

const revision = "a".repeat(40);
const manifest = {
    version: "0.8.0",
    revision,
    platform: "linux/amd64",
    images: ["auth", "dashboard"].map((app) => ({
        app,
        reference: `ghcr.io/demo/homelab/${app}:0.8.0@sha256:${"b".repeat(64)}`,
    })),
};
const evidence = {
    name: "release-manifest-1.json",
    expired: false,
    digest: `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
    workflow_run: { id: 100, head_sha: revision },
};

function fixture(
    options: {
        tag?: string;
        manifest?: unknown;
        conclusion?: string;
        redirect?: string;
        artifacts?: unknown[];
        attempt?: number;
        windows?: unknown;
        windowsAssets?: unknown[];
        windowsEvidence?: unknown[];
        browser?: unknown;
        browserAssets?: unknown[];
        browserEvidence?: unknown[];
    } = {}
) {
    const requests: { url: string; authorization: string | null }[] = [];
    const respond = (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ) => {
        const url = input instanceof Request ? input.url : input.toString();
        requests.push({
            url,
            authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.endsWith("/releases/latest"))
            return Response.json({
                tag_name: "v0.8.0",
                draft: false,
                prerelease: false,
                assets: [
                    { id: 42, name: "container-images.json" },
                    ...(options.windowsAssets ?? []),
                    ...(options.browserAssets ?? []),
                ],
            });
        if (url.endsWith("/releases/assets/43")) return Response.json(options.windows);
        if (url.endsWith("/releases/assets/45")) return Response.json(options.browser);
        if (url.includes("name=browser-manifest-"))
            return Response.json({ artifacts: options.browserEvidence ?? [] });
        if (url.includes("name=computer-manifest-"))
            return Response.json({ artifacts: options.windowsEvidence ?? [] });
        if (url.endsWith("/releases/assets/42"))
            return new Response(null, {
                status: 302,
                headers: {
                    location:
                        options.redirect ??
                        "https://release-assets.githubusercontent.com/test/manifest",
                },
            });
        if (url.startsWith("https://release-assets.githubusercontent.com/"))
            return Response.json(options.manifest ?? manifest);
        if (url.includes("/git/ref/"))
            return Response.json({
                object: { type: "commit", sha: options.tag ?? revision },
            });
        if (url.includes("/actions/runs?"))
            return Response.json({
                workflow_runs: [
                    {
                        id: 100,
                        run_attempt: options.attempt ?? 1,
                        head_sha: revision,
                        event: "release",
                        path: ".github/workflows/container-images.yml",
                        status: "completed",
                        conclusion: options.conclusion ?? "success",
                    },
                ],
            });
        if (url.includes("/actions/runs/100/artifacts?"))
            return Response.json({ artifacts: options.artifacts ?? [evidence] });
        throw new Error("Unexpected request");
    };
    const request = Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            Promise.resolve(respond(input, init)),
        { preconnect: fetch.preconnect }
    );
    return { request, requests };
}

test("release evidence binds both immutable images to the tag and exact tested commit", async () => {
    const client = fixture();
    const result = await readHomelabRelease(
        "demo/homelab",
        "synthetic-token",
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.verified).toBe(true);
    expect(result.revision).toBe(revision);
    expect(result.images).toHaveLength(2);
    expect(
        client.requests
            .filter((request) => request.url.startsWith("https://api.github.com/"))
            .every((request) => request.authorization === "Bearer synthetic-token")
    ).toBe(true);
    expect(
        client.requests.find((request) =>
            request.url.startsWith("https://release-assets.githubusercontent.com/")
        )?.authorization
    ).toBeNull();
});

test("release reporting refuses changed tags, partial images and off-origin redirects", async () => {
    for (const options of [
        { tag: "c".repeat(40) },
        { manifest: { ...manifest, images: manifest.images.slice(0, 1) } },
        { manifest: { ...manifest, images: [manifest.images[0], manifest.images[0]] } },
        {
            manifest: {
                ...manifest,
                images: [
                    manifest.images[0],
                    {
                        app: "mira",
                        reference: `ghcr.io/demo/homelab/mira:0.8.0@sha256:${"b".repeat(64)}`,
                    },
                ],
            },
        },
        { manifest: { ...manifest, version: "0.9.0" } },
        { redirect: "https://untrusted.example/asset" },
    ]) {
        const client = fixture(options);
        const error = await readHomelabRelease(
            "demo/homelab",
            "synthetic-token",
            AbortSignal.timeout(1000),
            client.request
        ).then(
            () => null,
            (error_: unknown) => error_
        );
        expect(error).toBeInstanceOf(Error);
        expect(
            client.requests.some((request) => request.url.includes("untrusted.example"))
        ).toBe(false);
    }
});

test("release evidence accepts the separately tested Mira image while retaining legacy releases", async () => {
    const upgraded = {
        ...manifest,
        images: [
            ...manifest.images,
            {
                app: "mira",
                reference: `ghcr.io/demo/homelab/mira:0.8.0@sha256:${"c".repeat(64)}`,
            },
        ],
    };
    const client = fixture({
        manifest: upgraded,
        artifacts: [
            {
                ...evidence,
                digest: `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(upgraded)).digest("hex")}`,
            },
        ],
    });
    const result = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.verified).toBe(true);
    expect(result.images.map((image) => image.app)).toEqual([
        "auth",
        "dashboard",
        "mira",
    ]);
});

test("a failed release build is reported without claiming the publication is verified", async () => {
    const client = fixture({ conclusion: "failure" });
    const result = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.verified).toBe(false);
    expect(result.tests).toBe("failure");
    expect(client.requests.some(({ url }) => url.includes("/artifacts?"))).toBe(false);
});

test("a replaced manifest cannot borrow successful tests from its tag's earlier build", async () => {
    const client = fixture({
        manifest: {
            ...manifest,
            images: manifest.images.map((image) => ({
                ...image,
                reference: image.reference.replace("b".repeat(64), "c".repeat(64)),
            })),
        },
    });
    const result = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.tests).toBe("success");
    expect(result.verified).toBe(false);
});

test("verification requires unexpired evidence from the exact workflow run and attempt", async () => {
    for (const options of [
        { artifacts: [] },
        { artifacts: [{ ...evidence, expired: true }] },
        { artifacts: [{ ...evidence, digest: null }] },
        { artifacts: [{ ...evidence, workflow_run: { id: 101, head_sha: revision } }] },
        {
            artifacts: [
                { ...evidence, workflow_run: { id: 100, head_sha: "c".repeat(40) } },
            ],
        },
        { artifacts: [evidence, evidence] },
        { attempt: 2 },
    ]) {
        const client = fixture(options);
        const result = await readHomelabRelease(
            "demo/homelab",
            undefined,
            AbortSignal.timeout(1000),
            client.request
        );
        expect(result.verified).toBe(false);
    }
    const client = fixture({
        attempt: 2,
        artifacts: [{ ...evidence, name: "release-manifest-2.json" }],
    });
    const result = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.verified).toBe(true);
    expect(client.requests.at(-1)?.url).toContain("name=release-manifest-2.json");
});

const windows = {
    schemaVersion: 1,
    version: "0.8.0",
    revision,
    platform: "windows-x64",
    installer: {
        name: "mira-computer-0.8.0-windows-x64-setup.exe",
        size: 123,
        sha256: "e".repeat(64),
    },
};
const windowsAssets = [
    { id: 43, name: "mira-computer-0.8.0-windows-x64.json" },
    {
        id: 44,
        name: windows.installer.name,
        size: 123,
        state: "uploaded",
        digest: `sha256:${windows.installer.sha256}`,
    },
];
const windowsEvidence = [
    {
        ...evidence,
        name: "computer-manifest-1.json",
        digest: `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(windows)).digest("hex")}`,
    },
];

test("Windows downloads require the exact tested manifest, current workflow attempt and matching uploaded installer", async () => {
    const result = await readHomelabRelease(
        "demo/homelab",
        "synthetic-token",
        AbortSignal.timeout(1000),
        fixture({ windows, windowsAssets, windowsEvidence }).request
    );
    expect(result.computer).toEqual({
        version: "0.8.0",
        revision,
        size: 123,
        sha256: windows.installer.sha256,
        url: "https://github.com/demo/homelab/releases/download/v0.8.0/mira-computer-0.8.0-windows-x64-setup.exe",
    });
    for (const options of [
        { windowsAssets: [] },
        { windowsAssets: [windowsAssets[0]] },
        { windowsAssets: [...windowsAssets, windowsAssets[1]] },
        { windowsAssets: [windowsAssets[0], { ...windowsAssets[1], size: 124 }] },
        { windowsAssets: [windowsAssets[0], { ...windowsAssets[1], state: "starter" }] },
        {
            windowsAssets: [
                windowsAssets[0],
                { ...windowsAssets[1], digest: "sha256:" + "f".repeat(64) },
            ],
        },
        { windows: { ...windows, version: "0.8.1" } },
        { windows: { ...windows, revision: "c".repeat(40) } },
        { windows: { ...windows, platform: "linux-x64" } },
        { windows: { ...windows, schemaVersion: 2 } },
        {
            windows: {
                ...windows,
                installer: { ...windows.installer, name: "unsafe.exe" },
            },
        },
        { windows: { ...windows, files: [] } }, // Changed raw bytes, even if the projection is unchanged.
        { windowsEvidence: [] },
        { windowsEvidence: [{ ...windowsEvidence[0], expired: true }] },
        {
            windowsEvidence: [
                { ...windowsEvidence[0], name: "computer-manifest-2.json" },
            ],
        },
        {
            windowsEvidence: [
                { ...windowsEvidence[0], workflow_run: { id: 99, head_sha: revision } },
            ],
        },
        {
            windowsEvidence: [
                {
                    ...windowsEvidence[0],
                    workflow_run: { id: 100, head_sha: "b".repeat(40) },
                },
            ],
        },
    ]) {
        const unavailable = await readHomelabRelease(
            "demo/homelab",
            undefined,
            AbortSignal.timeout(1000),
            fixture({ windows, windowsAssets, windowsEvidence, ...options }).request
        );
        expect(unavailable.verified).toBe(true);
        expect(unavailable.computer).toBeNull();
    }
    const failed = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        fixture({ windows, windowsAssets, windowsEvidence, conclusion: "failure" })
            .request
    );
    expect(failed.computer).toBeNull();
});

const browser = {
    version: "0.8.0",
    revision,
    platform: "linux/amd64",
    images: (["mira-browser", "mira-browser-proxy"] as const).map((app) => ({
        app,
        tag: `ghcr.io/demo/homelab/${app}:0.8.0`,
        reference: `ghcr.io/demo/homelab/${app}:0.8.0@sha256:${"f".repeat(64)}`,
    })),
};
const browserAssets = [{ id: 45, name: "browser-image.json" }];
const browserEvidence = [
    {
        ...evidence,
        name: "browser-manifest-1.json",
        digest: `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(browser)).digest("hex")}`,
    },
];

test("browser and proxy publication must match the exact verified release and workflow attempt", async () => {
    const result = await readHomelabRelease(
        "demo/homelab",
        "synthetic-token",
        AbortSignal.timeout(1000),
        fixture({ browser, browserAssets, browserEvidence }).request
    );
    expect(result.browser).toEqual({
        version: browser.version,
        revision,
        platform: "linux/amd64",
        images: browser.images.map(({ app, reference }) => ({ app, reference })),
    });
    for (const options of [
        { browserAssets: [] },
        { browserAssets: [...browserAssets, ...browserAssets] },
        { browser: { ...browser, version: "0.8.1" } },
        { browser: { ...browser, revision: "c".repeat(40) } },
        { browser: { ...browser, platform: "linux/arm64" } },
        { browser: { ...browser, images: browser.images.slice(0, 1) } },
        { browser: { ...browser, images: [browser.images[0], browser.images[0]] } },
        {
            browser: {
                ...browser,
                images: browser.images.map((image) => ({
                    ...image,
                    reference: image.reference.replace("demo/homelab", "other/homelab"),
                })),
            },
        },
        {
            browser: {
                ...browser,
                images: browser.images.map((image) => ({
                    ...image,
                    reference: image.tag,
                })),
            },
        },
        { browser: { ...browser, changed: true } },
        { browserEvidence: [] },
        { browserEvidence: [...browserEvidence, ...browserEvidence] },
        { browserEvidence: [{ ...browserEvidence[0], expired: true }] },
        { browserEvidence: [{ ...browserEvidence[0], digest: null }] },
        { browserEvidence: [{ ...browserEvidence[0], name: "browser-manifest-2.json" }] },
        {
            browserEvidence: [
                { ...browserEvidence[0], workflow_run: { id: 101, head_sha: revision } },
            ],
        },
        {
            browserEvidence: [
                {
                    ...browserEvidence[0],
                    workflow_run: { id: 100, head_sha: "b".repeat(40) },
                },
            ],
        },
    ]) {
        const matchingEvidence =
            "browser" in options && options.browser && !("changed" in options.browser)
                ? browserEvidence.map((artifact) => ({
                      ...artifact,
                      digest: `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(options.browser)).digest("hex")}`,
                  }))
                : browserEvidence;
        const unavailable = await readHomelabRelease(
            "demo/homelab",
            undefined,
            AbortSignal.timeout(1000),
            fixture({
                browser,
                browserAssets,
                browserEvidence: matchingEvidence,
                ...options,
            }).request
        );
        expect(unavailable.verified).toBe(true);
        expect(unavailable.browser).toBeNull();
    }
    for (const options of [{ conclusion: "failure" }, { artifacts: [] }]) {
        const client = fixture({ browser, browserAssets, browserEvidence, ...options });
        const unverified = await readHomelabRelease(
            "demo/homelab",
            undefined,
            AbortSignal.timeout(1000),
            client.request
        );
        expect(unverified.browser).toBeNull();
        expect(
            client.requests.some(({ url }) => url.endsWith("/releases/assets/45"))
        ).toBe(false);
    }
});
