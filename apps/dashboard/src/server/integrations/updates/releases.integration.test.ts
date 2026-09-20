import { expect, test } from "bun:test";

import type { UpdateItem } from "@homelab/contracts/updates";

import { dockerHubVersionTag } from "./dockerHubTags";
import { publicImageReference, imageVersionTag } from "./imageReference";
import { latestImage, resolveImageUpdate } from "./registry";
import { compareRelease, latestRelease } from "./releases";

const image: UpdateItem = {
    id: "demo",
    name: "Demo",
    kind: "container",
    installed: "sha256:" + "a".repeat(64),
    available: null,
    status: "unknown",
    security: false,
    held: false,
    image: "example/web:latest",
    platform: { os: "linux", architecture: "amd64" },
};

test("public registry checks enforce fixed pull scopes and compare the correct platform config digest", async () => {
    const requests: { path: string; authorization: string | null }[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            const url = new URL(request.url);
            requests.push({
                path: url.pathname,
                authorization: request.headers.get("authorization"),
            });
            if (url.pathname === "/token") {
                expect(url.searchParams.get("scope")).toBe("repository:example/web:pull");
                return Response.json({ token: "synthetic-read-token" });
            }
            if (!request.headers.has("authorization"))
                return new Response("", {
                    status: 401,
                    headers: {
                        "WWW-Authenticate":
                            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:wrong:push"',
                    },
                });
            if (url.pathname.endsWith("/latest"))
                return Response.json({
                    manifests: [
                        {
                            digest: "sha256:" + "b".repeat(64),
                            platform: { os: "linux", architecture: "arm64" },
                        },
                        {
                            digest: "sha256:" + "c".repeat(64),
                            platform: { os: "linux", architecture: "amd64" },
                        },
                    ],
                });
            return Response.json({ config: { digest: "sha256:" + "d".repeat(64) } });
        },
    });
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
            const upstream = new URL(input instanceof Request ? input.url : input);
            expect(["registry-1.docker.io", "auth.docker.io"]).toContain(
                upstream.hostname
            );
            return fetch(
                new URL(upstream.pathname + upstream.search, server.url),
                options
            );
        },
        { preconnect: fetch.preconnect }
    );
    try {
        expect(await latestImage(image, AbortSignal.timeout(2000), request)).toBe(
            "sha256:" + "d".repeat(64)
        );
        expect(requests).toHaveLength(6);
        expect(requests[1]?.authorization).toBeNull();
        expect(
            await latestImage(
                { ...image, image: "https://localhost/private" },
                AbortSignal.timeout(2000),
                request
            )
        ).toBeNull();
        expect(
            await latestImage(
                { ...image, image: "private.example/web:latest" },
                AbortSignal.timeout(2000),
                request
            )
        ).toBeNull();
        expect(
            await latestImage(
                { ...image, image: "example/web@sha256:" + "a".repeat(64) },
                AbortSignal.timeout(2000),
                request
            )
        ).toBe("sha256:" + "d".repeat(64));
        expect(
            await latestImage(
                { ...image, platform: { os: "windows", architecture: "amd64" } },
                AbortSignal.timeout(2000),
                request
            )
        ).toBeNull();
    } finally {
        await server.stop(true);
    }
});

test("pinned stable image versions discover newer same-flavor tags without following pagination URLs", async () => {
    const requests: string[] = [];
    const resultDigest = "sha256:" + "e".repeat(64);
    const manifestDigest = "sha256:" + "f".repeat(64);
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0]) => {
            const url = new URL(input instanceof Request ? input.url : input);
            requests.push(url.href);
            expect(url.origin).toBe("https://ghcr.io");
            if (url.pathname.endsWith("/tags/list")) {
                if (!url.searchParams.has("last"))
                    return Promise.resolve(
                        Response.json(
                            {
                                tags: [
                                    "v1.2.3-alpine",
                                    "v1.3.0-alpine",
                                    "v9.0.0-bookworm",
                                    "v9.0.0-rc.1",
                                ],
                            },
                            {
                                headers: {
                                    Link: '<http://localhost/private>; rel="next"',
                                },
                            }
                        )
                    );
                expect(url.searchParams.get("last")).toBe("v9.0.0-rc.1");
                return Promise.resolve(Response.json({ tags: ["v2.0.0-alpine"] }));
            }
            expect(url.pathname).toBe("/v2/example/web/manifests/v2.0.0-alpine");
            return Promise.resolve(
                Response.json(
                    { config: { digest: resultDigest } },
                    { headers: { "Docker-Content-Digest": manifestDigest } }
                )
            );
        },
        { preconnect: fetch.preconnect }
    );
    const result = await resolveImageUpdate(
        { ...image, image: "ghcr.io/example/web:v1.2.3-alpine@sha256:" + "a".repeat(64) },
        AbortSignal.timeout(2000),
        request
    );
    expect(result).toEqual({
        imageId: resultDigest,
        reference: `ghcr.io/example/web:v2.0.0-alpine@${manifestDigest}`,
        installedVersion: "1.2.3",
        availableVersion: "2.0.0",
    });
    expect(requests).toHaveLength(3);
});

test("explicit tracking tags avoid release scans and malformed pins never reach a registry", async () => {
    const paths: string[] = [];
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0]) => {
            paths.push(new URL(input instanceof Request ? input.url : input).pathname);
            return Promise.resolve(
                Response.json({ config: { digest: "sha256:" + "e".repeat(64) } })
            );
        },
        { preconnect: fetch.preconnect }
    );
    await latestImage(
        {
            ...image,
            image: "example/web:1.0.0@sha256:" + "a".repeat(64),
            imageTag: "stable",
        },
        AbortSignal.timeout(2000),
        request
    );
    expect(paths).toEqual([
        "/v2/example/web/manifests/stable",
        "/v2/example/web/blobs/sha256:" + "e".repeat(64),
    ]);
    expect(publicImageReference("example/web@broken")).toBeNull();
    expect(
        publicImageReference("example/web@sha256:" + "a".repeat(64) + "@other")
    ).toBeNull();
    expect(publicImageReference("example/web", "https://private")).toBeNull();
    expect(imageVersionTag("1.2.3-beta.1")).toBeNull();
    expect(imageVersionTag("latest")).toBeNull();
});

test("incomplete image tag catalogs fail instead of being reported as current", async () => {
    const request: typeof fetch = Object.assign(
        () =>
            Promise.resolve(
                Response.json(
                    { tags: ["1.0.0"] },
                    { headers: { Link: '<ignored>; rel="next"' } }
                )
            ),
        { preconnect: fetch.preconnect }
    );
    const failure = await latestImage(
        { ...image, image: "ghcr.io/example/web:1.0.0" },
        AbortSignal.timeout(2000),
        request
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("pagination did not advance");
});

test("large Hub catalogs expose a newer pinned-image candidate without following remote next URLs", async () => {
    const requests: URL[] = [];
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
            const url = new URL(input instanceof Request ? input.url : input);
            requests.push(url);
            expect(options?.redirect).toBe("error");
            expect(new Headers(options?.headers).has("authorization")).toBe(false);
            if (url.hostname === "hub.docker.com") {
                expect(url.pathname).toBe("/v2/namespaces/example/repositories/web/tags");
                expect(url.searchParams.get("page_size")).toBe("100");
                return Promise.resolve(
                    Response.json({
                        next: "http://localhost/private",
                        results: ["2.4.1", "2.5.0", "3.0.0-rc.1", "9.0.0-alpine"].map(
                            (name) => ({ name })
                        ),
                    })
                );
            }
            expect(url.origin).toBe("https://registry-1.docker.io");
            expect(url.pathname).toBe("/v2/example/web/manifests/2.5.0");
            return Promise.resolve(
                Response.json({ config: { digest: "sha256:" + "d".repeat(64) } })
            );
        },
        { preconnect: fetch.preconnect }
    );
    const result = await resolveImageUpdate(
        { ...image, image: "example/web:2.4.0@sha256:" + "a".repeat(64) },
        AbortSignal.timeout(2000),
        request
    );
    expect(result?.reference).toBe("docker.io/example/web:2.5.0");
    expect(requests).toHaveLength(2);
});

test("partial Hub catalogs never claim current and stop at the fixed page budget", async () => {
    let count = 0;
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0]) => {
            const url = new URL(input instanceof Request ? input.url : input);
            count += 1;
            expect(url.hostname).toBe("hub.docker.com");
            expect(url.searchParams.get("page")).toBe(String(count));
            return Promise.resolve(
                Response.json({
                    next: "https://private.invalid",
                    results: [{ name: `0.1.${count}` }],
                })
            );
        },
        { preconnect: fetch.preconnect }
    );
    const failure = await dockerHubVersionTag(
        "example/web",
        "1.0.0",
        AbortSignal.timeout(2000),
        request
    ).catch((error: unknown) => error);
    expect(String(failure)).toContain("exceeds the lookup budget");
    expect(count).toBe(5);
});

test("complete Hub catalogs preserve an up-to-date tag without accepting arbitrary repository paths", async () => {
    let count = 0;
    const request: typeof fetch = Object.assign(
        () => {
            count += 1;
            return Promise.resolve(
                Response.json({ next: null, results: [{ name: "1.0.0" }] })
            );
        },
        { preconnect: fetch.preconnect }
    );
    expect(
        await dockerHubVersionTag(
            "example/web",
            "1.0.0",
            AbortSignal.timeout(2000),
            request
        )
    ).toBe("1.0.0");
    const failure = await dockerHubVersionTag(
        "../private",
        "1.0.0",
        AbortSignal.timeout(2000),
        request
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(count).toBe(1);
});

test.each([
    [
        "nginx:latest",
        "registry-1.docker.io",
        "auth.docker.io",
        "registry.docker.io",
        "library/nginx",
    ],
    [
        "docker.io/nginx:latest",
        "registry-1.docker.io",
        "auth.docker.io",
        "registry.docker.io",
        "library/nginx",
    ],
    [
        "registry-1.docker.io/example/web:latest",
        "registry-1.docker.io",
        "auth.docker.io",
        "registry.docker.io",
        "example/web",
    ],
    ["ghcr.io/example/web:latest", "ghcr.io", "ghcr.io", "ghcr.io", "example/web"],
    [
        "index.docker.io/library/nginx:latest",
        "registry-1.docker.io",
        "auth.docker.io",
        "registry.docker.io",
        "library/nginx",
    ],
    [
        "index.docker.io/nginx:latest",
        "registry-1.docker.io",
        "auth.docker.io",
        "registry.docker.io",
        "library/nginx",
    ],
    [
        "index.docker.io/example/web:latest",
        "registry-1.docker.io",
        "auth.docker.io",
        "registry.docker.io",
        "example/web",
    ],
])(
    "registry %s uses only its exact configured hosts and pull scope",
    async (reference, host, authHost, service, repository) => {
        const requests: URL[] = [];
        const resultDigest = "sha256:" + "e".repeat(64);
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
                const url = new URL(request.url);
                if (url.pathname === "/token") {
                    expect(url.searchParams.get("service")).toBe(service);
                    expect(url.searchParams.get("scope")).toBe(
                        `repository:${repository}:pull`
                    );
                    expect(request.headers.has("authorization")).toBe(false);
                    return Response.json({ token: "synthetic-read-token" });
                }
                expect([
                    `/v2/${repository}/manifests/latest`,
                    `/v2/${repository}/blobs/${image.installed}`,
                    `/v2/${repository}/blobs/${resultDigest}`,
                ]).toContain(url.pathname);
                if (!request.headers.has("authorization"))
                    return new Response("", {
                        status: 401,
                        headers: {
                            "WWW-Authenticate": `Bearer realm="https://${authHost}/token"`,
                        },
                    });
                expect(request.headers.get("authorization")).toBe(
                    "Bearer synthetic-read-token"
                );
                if (url.pathname.includes("/blobs/"))
                    return Response.json({
                        config: {
                            Labels: {
                                "org.opencontainers.image.version": url.pathname.endsWith(
                                    image.installed
                                )
                                    ? "1.2.0"
                                    : "1.3.0",
                            },
                        },
                    });
                return Response.json({ config: { digest: resultDigest } });
            },
        });
        const request: typeof fetch = Object.assign(
            (
                input: Parameters<typeof fetch>[0],
                options?: Parameters<typeof fetch>[1]
            ) => {
                const upstream = new URL(input instanceof Request ? input.url : input);
                requests.push(upstream);
                expect(options?.redirect).toBe("error");
                return fetch(
                    new URL(upstream.pathname + upstream.search, server.url),
                    options
                );
            },
            { preconnect: fetch.preconnect }
        );
        try {
            expect(
                await latestImage(
                    { ...image, image: reference },
                    AbortSignal.timeout(2000),
                    request
                )
            ).toBe(resultDigest);
            expect(requests.map((url) => url.hostname)).toEqual([
                host,
                authHost,
                host,
                host,
                host,
            ]);
            expect(requests.every((url) => url.protocol === "https:")).toBe(true);
        } finally {
            await server.stop(true);
        }
    }
);

test.each([
    "localhost/web:latest",
    "localhost:5000/web:latest",
    "10.0.0.1/web:latest",
    "127.0.0.1/private/web:latest",
    "[::1]/web:latest",
    "[2001:db8::1]:5000/web:latest",
    "registry.example2/web:latest",
    "registry.internal/private/web:latest",
    "registry:5000/web:latest",
    "docker.io:443/web:latest",
    "Registry/web:latest",
    "docker.io.attacker.example/web:latest",
    "evil-docker.io/web:latest",
    "registry-1.docker.io.attacker.example/web:latest",
    "ghcr.io.attacker.example/web:latest",
    "index.docker.io.attacker.example/web:latest",
    "evil-index.docker.io/web:latest",
])("lookalike registry %s never makes an outbound request", async (reference) => {
    const request: typeof fetch = Object.assign(
        () => {
            throw new Error("Unexpected outbound request");
        },
        { preconnect: fetch.preconnect }
    );
    expect(
        await latestImage(
            { ...image, image: reference },
            AbortSignal.timeout(2000),
            request
        )
    ).toBeNull();
});

test("release feeds use semantic order and discard arbitrary remote URLs", async () => {
    let mode = "bun";
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
            if (mode === "node") return Response.json([{ version: "v26.9.0" }]);
            if (mode === "openclaw") return Response.json({ version: "2026.9.20" });
            if (mode === "github-cli") return Response.json({ tag_name: "v2.85.0" });
            return Response.json({
                tag_name: "bun-v1.5.0",
                assets: [{ browser_download_url: "http://localhost/private" }],
            });
        },
    });
    const request: typeof fetch = Object.assign(
        (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) =>
            fetch(server.url, options),
        { preconnect: fetch.preconnect }
    );
    try {
        expect(await latestRelease("bun", AbortSignal.timeout(2000), request)).toBe(
            "1.5.0"
        );
        mode = "node";
        expect(await latestRelease("node", AbortSignal.timeout(2000), request)).toBe(
            "26.9.0"
        );
        mode = "openclaw";
        expect(await latestRelease("openclaw", AbortSignal.timeout(2000), request)).toBe(
            "2026.9.20"
        );
        mode = "github-cli";
        expect(
            await latestRelease("github-cli", AbortSignal.timeout(2000), request)
        ).toBe("2.85.0");
        expect(compareRelease("1.9.0", "1.10.0")).toBe("available");
        expect(compareRelease("v2.0.0", "1.10.0")).toBe("current");
        expect(compareRelease("main", "1.10.0")).toBe("unknown");
        expect(compareRelease("1.10.0-rc.1", "1.10.0")).toBe("available");
    } finally {
        await server.stop(true);
    }
});
