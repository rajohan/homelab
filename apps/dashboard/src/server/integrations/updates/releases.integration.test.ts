import { expect, test } from "bun:test";

import type { UpdateItem } from "@homelab/contracts/updates";

import { latestImage } from "./registry";
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
        expect(requests).toHaveLength(4);
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
        ).toBeNull();
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
                expect(url.pathname).toBe(`/v2/${repository}/manifests/latest`);
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
            expect(requests.map((url) => url.hostname)).toEqual([host, authHost, host]);
            expect(requests.every((url) => url.protocol === "https:")).toBe(true);
        } finally {
            await server.stop(true);
        }
    }
);

test.each([
    "docker.io.attacker.example/web:latest",
    "evil-docker.io/web:latest",
    "registry-1.docker.io.attacker.example/web:latest",
    "ghcr.io.attacker.example/web:latest",
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
