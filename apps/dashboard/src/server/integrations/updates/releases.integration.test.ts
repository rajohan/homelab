import { expect, test } from "bun:test";

import { updateChange, type UpdateItem } from "@homelab/contracts/updates";

import { dockerHubVersionTag } from "./dockerHubTags";
import { publicImageReference, imageVersionTag } from "./imageReference";
import { resolveUpdates } from "./job";
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

const imageConfiguration = (version?: string) => ({
    os: "linux",
    architecture: "amd64",
    config: { Labels: version ? { "org.opencontainers.image.version": version } : {} },
});

const fixtureDigest = (letter: string) => "sha256:" + letter.repeat(64);
const manifestResponse = (body: unknown, identity: string) =>
    Response.json(body, { headers: { "Docker-Content-Digest": identity } });
const indexManifestResponse = (identity: string, manifest: string) =>
    manifestResponse(
        {
            manifests: [
                {
                    digest: manifest,
                    platform: { os: "linux", architecture: "amd64" },
                },
                {
                    digest: fixtureDigest("9"),
                    platform: { os: "linux", architecture: "arm64" },
                },
            ],
        },
        identity
    );

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
            if (url.pathname.includes("/blobs/"))
                return Response.json(imageConfiguration());
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
            if (url.pathname.includes("/blobs/"))
                return Promise.resolve(Response.json(imageConfiguration()));
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
        current: false,
        reference: `ghcr.io/example/web:v2.0.0-alpine@${manifestDigest}`,
        installedVersion: "1.2.3",
        availableVersion: "2.0.0",
    });
    expect(requests).toHaveLength(4);
});

test("explicit tracking tags avoid release scans and malformed pins never reach a registry", async () => {
    const paths: string[] = [];
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0]) => {
            paths.push(new URL(input instanceof Request ? input.url : input).pathname);
            if (paths.at(-1)?.includes("/blobs/"))
                return Promise.resolve(Response.json(imageConfiguration()));
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
        "/v2/example/web/blobs/sha256:" + "a".repeat(64),
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
            expect(options?.redirect).toBe(
                url.pathname.includes("/blobs/") ? "manual" : "error"
            );
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
            if (url.pathname.includes("/blobs/"))
                return Promise.resolve(Response.json(imageConfiguration()));
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
    expect(requests).toHaveLength(3);
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
                        os: "linux",
                        architecture: "amd64",
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
                expect(options?.redirect).toBe(
                    upstream.pathname.includes("/blobs/") ? "manual" : "error"
                );
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

test.each([
    { kind: "container", persistent: false },
    { kind: "container", persistent: true },
    { kind: "application", persistent: false },
    { kind: "application", persistent: true },
] as const)(
    "public lookups retry once and share the result: $kind persistent=$persistent",
    async ({ kind, persistent }) => {
        let lookups = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
                const path = new URL(request.url).pathname;
                if (kind === "application" || path.endsWith("/manifests/latest")) {
                    lookups += 1;
                    if (persistent || lookups === 1)
                        return new Response(null, { status: 503 });
                    if (kind === "application")
                        return Response.json([{ version: "v26.8.2" }]);
                    return manifestResponse(
                        { config: { digest: image.installed } },
                        fixtureDigest("b")
                    );
                }
                return Response.json(imageConfiguration());
            },
        });
        const request: typeof fetch = Object.assign(
            (
                input: Parameters<typeof fetch>[0],
                options?: Parameters<typeof fetch>[1]
            ) => {
                const url = new URL(input instanceof Request ? input.url : input);
                expect(["registry-1.docker.io", "nodejs.org"]).toContain(url.hostname);
                return fetch(new URL(url.pathname, server.url), options);
            },
            { preconnect: fetch.preconnect }
        );
        const item: UpdateItem =
            kind === "container"
                ? image
                : {
                      id: "application:node",
                      name: "Node",
                      kind,
                      release: "node",
                      installed: "26.8.2",
                      available: null,
                      status: "unknown",
                      security: false,
                      held: false,
                  };
        try {
            const result = await resolveUpdates(
                {
                    capturedAt: new Date().toISOString(),
                    repositoryMetadataAt: null,
                    complete: true,
                    coveredKinds: [kind],
                    items: [item, { ...item, id: "second" }, { ...item, id: "third" }],
                },
                AbortSignal.timeout(2000),
                new Map(),
                request
            );
            expect(lookups).toBe(2);
            for (const observation of result.items) {
                expect(observation.status).toBe(persistent ? "unknown" : "current");
                expect(observation.candidateVerified).toBe(!persistent);
                expect(observation.available).toBe(persistent ? null : item.installed);
                if (persistent) expect(observation.availableImage).toBeUndefined();
            }
        } finally {
            await server.stop(true);
        }
    }
);

test("cancelled registry checks do not retry or leave an available candidate", async () => {
    const controller = new AbortController();
    let lookups = 0;
    const request: typeof fetch = Object.assign(
        () => {
            lookups += 1;
            controller.abort(new Error("Synthetic cancellation"));
            return Promise.reject(new Error("Synthetic unavailable registry"));
        },
        { preconnect: fetch.preconnect }
    );
    const failure = await resolveUpdates(
        {
            capturedAt: new Date().toISOString(),
            repositoryMetadataAt: null,
            complete: true,
            coveredKinds: ["container"],
            items: [image],
        },
        controller.signal,
        new Map(),
        request
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Synthetic cancellation");
    expect(lookups).toBe(1);
});

test("shared mutable-tag lookups retain each installed digest's actual version", async () => {
    const secondDigest = "sha256:" + "b".repeat(64);
    const nextDigest = "sha256:" + "c".repeat(64);
    const lookups: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            const path = new URL(request.url).pathname;
            lookups.push(path);
            if (path.endsWith("/manifests/latest"))
                return Response.json(
                    { config: { digest: nextDigest } },
                    {
                        headers: { "Docker-Content-Digest": "sha256:" + "d".repeat(64) },
                    }
                );
            let version = "1.3.0";
            if (path.endsWith(image.installed)) version = "1.2.0";
            else if (path.endsWith(secondDigest)) version = "2.0.0";
            return Response.json({
                os: "linux",
                architecture: "amd64",
                config: { Labels: { "org.opencontainers.image.version": version } },
            });
        },
    });
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
            const upstream = new URL(input instanceof Request ? input.url : input);
            expect(upstream.origin).toBe("https://registry-1.docker.io");
            return fetch(new URL(upstream.pathname, server.url), options);
        },
        { preconnect: fetch.preconnect }
    );
    try {
        const result = await resolveUpdates(
            {
                capturedAt: new Date().toISOString(),
                repositoryMetadataAt: null,
                complete: true,
                coveredKinds: ["container"],
                items: [
                    image,
                    { ...image, id: "second", installed: secondDigest },
                    { ...image, id: "duplicate" },
                ],
            },
            AbortSignal.timeout(5000),
            new Map(),
            request
        );
        expect(result.items.map((item) => item.installedVersion)).toEqual([
            "1.2.0",
            "2.0.0",
            "1.2.0",
        ]);
        expect(result.items.map(updateChange)).toEqual(["minor", "unknown", "minor"]);
        expect(
            result.items.every(
                (item) => item.candidateVerified && item.available === nextDigest
            )
        ).toBe(true);
        expect(lookups.filter((path) => path.endsWith("/manifests/latest"))).toHaveLength(
            2
        );
        expect(lookups.filter((path) => path.endsWith(image.installed))).toHaveLength(1);
        expect(lookups.filter((path) => path.endsWith(secondDigest))).toHaveLength(1);
    } finally {
        await server.stop(true);
    }
});

test.each([
    { label: "classic current", store: "config", sameIndex: true, sameContent: true },
    { label: "classic update", store: "config", sameIndex: false, sameContent: false },
    { label: "containerd current", store: "index", sameIndex: true, sameContent: true },
    { label: "containerd update", store: "index", sameIndex: false, sameContent: false },
    {
        label: "another architecture changed",
        store: "index",
        sameIndex: false,
        sameContent: true,
    },
    {
        label: "platform manifest current",
        store: "manifest",
        sameIndex: true,
        sameContent: true,
    },
    {
        label: "platform manifest update",
        store: "manifest",
        sameIndex: false,
        sameContent: false,
    },
    {
        label: "platform manifest unchanged by another architecture",
        store: "manifest",
        sameIndex: false,
        sameContent: true,
    },
])(
    "image identities: $label compares platform content and retains the post-pull ID kind",
    async ({ store, sameIndex, sameContent }) => {
        const oldIndex = fixtureDigest("a"),
            nextIndex = sameIndex ? oldIndex : fixtureDigest("b");
        const oldManifest = fixtureDigest("c"),
            nextManifest = sameContent ? oldManifest : fixtureDigest("d");
        const oldConfig = fixtureDigest("e"),
            nextConfig = sameContent ? oldConfig : fixtureDigest("f");
        const manifestId = store === "manifest" ? oldManifest : oldIndex;
        const local = store === "config" ? oldConfig : manifestId;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
                const path = decodeURIComponent(new URL(request.url).pathname);
                if (path.endsWith("/manifests/latest"))
                    return indexManifestResponse(nextIndex, nextManifest);
                if (path.endsWith("/manifests/" + nextIndex))
                    return indexManifestResponse(nextIndex, nextManifest);
                if (path.endsWith("/manifests/" + oldIndex))
                    return indexManifestResponse(oldIndex, oldManifest);
                if (path.endsWith("/manifests/" + oldManifest))
                    return manifestResponse(
                        { config: { digest: oldConfig } },
                        oldManifest
                    );
                if (path.endsWith("/manifests/" + nextManifest))
                    return manifestResponse(
                        { config: { digest: nextConfig } },
                        nextManifest
                    );
                if (path.endsWith("/blobs/" + oldConfig))
                    return Response.json(imageConfiguration("1.2.0"));
                if (path.endsWith("/blobs/" + nextConfig))
                    return Response.json(imageConfiguration("1.3.0"));
                return new Response(null, { status: 404 });
            },
        });
        const request: typeof fetch = Object.assign(
            (
                input: Parameters<typeof fetch>[0],
                options?: Parameters<typeof fetch>[1]
            ) => {
                const url = new URL(input instanceof Request ? input.url : input);
                expect(url.origin).toBe("https://ghcr.io");
                return fetch(new URL(url.pathname + url.search, server.url), options);
            },
            { preconnect: fetch.preconnect }
        );
        try {
            const result = await resolveUpdates(
                {
                    capturedAt: new Date().toISOString(),
                    repositoryMetadataAt: null,
                    complete: true,
                    coveredKinds: ["container"],
                    items: [
                        {
                            ...image,
                            installed: local,
                            image:
                                "ghcr.io/example/web@" +
                                (store === "manifest" ? oldManifest : oldIndex),
                        },
                    ],
                },
                AbortSignal.timeout(5000),
                new Map(),
                request
            );
            const item = result.items[0]!;
            expect(item.status).toBe(sameContent ? "current" : "available");
            expect(item.installed).toBe(local);
            expect(item.available).toBe(
                { config: nextConfig, manifest: nextManifest, index: nextIndex }[store]
            );
            const pullDigest = store === "manifest" ? nextManifest : nextIndex;
            expect(item.availableImage).toBe("ghcr.io/example/web:latest@" + pullDigest);
            // Exercise the resolver/executor boundary: containerd identifies the
            // requested descriptor, while classic Docker identifies its config.
            // A mocked executor returning item.available would hide this mismatch.
            const pulled = await request(
                `https://ghcr.io/v2/example/web/manifests/${pullDigest}`
            );
            expect(pulled.ok).toBe(true);
            const pulledId =
                store === "config"
                    ? nextConfig
                    : pulled.headers.get("docker-content-digest");
            expect(pulledId).toBe(item.available);
            expect(item.installedVersion).toBe("1.2.0");
            expect(item.availableVersion).toBe(sameContent ? "1.2.0" : "1.3.0");
            expect(item.candidateVerified).toBe(true);
        } finally {
            await server.stop(true);
        }
    }
);

test.each([
    ["docker.io", "https://production.cloudfront.docker.com"],
    ["docker.io", "https://production.cloudflare.docker.com"],
    [
        "docker.io",
        "https://docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
    ],
    ["ghcr.io", "https://pkg-containers.githubusercontent.com"],
    ["ghcr.io", "http://pkg-containers.githubusercontent.com"],
    ["ghcr.io", "https://pkg-containers.githubusercontent.com.evil.invalid"],
    ["ghcr.io", "https://pkg-containers.githubusercontent.com:8443"],
    ["ghcr.io", "https://user:pass@pkg-containers.githubusercontent.com"],
    ["ghcr.io", "https://127.0.0.1"],
    ["ghcr.io", "https://production.cloudfront.docker.com"],
    ["ghcr.io", "loop"],
])(
    "registry blob redirects preserve classic updates and credentials: %s %s",
    async (registry, destination) => {
        const trusted =
            destination === "https://pkg-containers.githubusercontent.com" ||
            registry === "docker.io";
        const origin =
            registry === "docker.io" ? "https://registry-1.docker.io" : "https://ghcr.io";
        const realm =
            registry === "docker.io"
                ? "https://auth.docker.io/token"
                : "https://ghcr.io/token";
        const oldConfig = fixtureDigest("a"),
            nextConfig = fixtureDigest("b");
        const seen: URL[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
                const url = new URL(request.url);
                const upstream = url.searchParams.get("upstream");
                if (url.pathname === "/token")
                    return Response.json({ token: "fixture-read-only" });
                if (url.pathname === "/blob") {
                    expect(request.headers.has("authorization")).toBe(false);
                    return destination === "loop"
                        ? new Response(null, {
                              status: 307,
                              headers: {
                                  Location:
                                      "https://pkg-containers.githubusercontent.com/blob",
                              },
                          })
                        : Response.json(
                              imageConfiguration(
                                  url.searchParams.get("digest") === oldConfig
                                      ? "1.2.0"
                                      : "1.3.0"
                              )
                          );
                }
                expect(upstream).toBe(origin);
                if (!request.headers.has("authorization"))
                    return new Response(null, {
                        status: 401,
                        headers: { "www-authenticate": `Bearer realm="${realm}"` },
                    });
                const path = decodeURIComponent(url.pathname);
                if (path.endsWith("/manifests/latest"))
                    return manifestResponse(
                        { config: { digest: nextConfig } },
                        fixtureDigest("c")
                    );
                if (path.includes("/blobs/"))
                    return new Response(null, {
                        status: 307,
                        headers: {
                            Location: `${destination === "loop" ? "https://pkg-containers.githubusercontent.com" : destination}/blob?digest=${path.split("/").at(-1)}`,
                        },
                    });
                return new Response(null, { status: 404 });
            },
        });
        const request: typeof fetch = Object.assign(
            (
                input: Parameters<typeof fetch>[0],
                options?: Parameters<typeof fetch>[1]
            ) => {
                const url = new URL(input instanceof Request ? input.url : input);
                seen.push(url);
                if (url.origin !== origin && url.origin !== new URL(realm).origin) {
                    expect(new Headers(options?.headers).has("authorization")).toBe(
                        false
                    );
                    expect(url.origin).toBe(
                        destination === "loop"
                            ? "https://pkg-containers.githubusercontent.com"
                            : destination
                    );
                }
                const local = new URL(url.pathname + url.search, server.url);
                local.searchParams.set("upstream", url.origin);
                return fetch(local, options);
            },
            { preconnect: fetch.preconnect }
        );
        try {
            const result = await resolveImageUpdate(
                {
                    ...image,
                    installed: oldConfig,
                    image: `${registry}/example/web:latest`,
                },
                AbortSignal.timeout(5000),
                request
            ).catch(() => null);
            if (trusted)
                expect(result).toMatchObject({
                    current: false,
                    imageId: nextConfig,
                    installedVersion: "1.2.0",
                    availableVersion: "1.3.0",
                });
            else {
                expect(result).toBeNull();
                expect(seen.filter((url) => url.pathname === "/blob")).toHaveLength(
                    destination === "loop" ? 4 : 0
                );
            }
        } finally {
            await server.stop(true);
        }
    }
);

test("unresolvable installed content never produces an available or current image claim", async () => {
    const hash = "sha256:" + "d".repeat(64);
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0]) => {
            const url = new URL(input instanceof Request ? input.url : input);
            return Promise.resolve(
                url.pathname.endsWith("/latest")
                    ? Response.json(
                          { config: { digest: hash } },
                          {
                              headers: {
                                  "Docker-Content-Digest": "sha256:" + "e".repeat(64),
                              },
                          }
                      )
                    : new Response(null, { status: 404 })
            );
        },
        { preconnect: fetch.preconnect }
    );
    const result = await resolveUpdates(
        {
            capturedAt: new Date().toISOString(),
            repositoryMetadataAt: null,
            complete: true,
            coveredKinds: ["container"],
            items: [image],
        },
        AbortSignal.timeout(2000),
        new Map(),
        request
    );
    expect(result.items[0]).toMatchObject({
        status: "unknown",
        available: null,
        candidateVerified: false,
    });
});

test("Nextcloud applies branch updates before the next major without cross-host cache contamination", async () => {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
            Response.json([
                { tag_name: "v35.0.0", draft: false, prerelease: false },
                { tag_name: "v34.0.3", draft: false, prerelease: false },
                { tag_name: "v33.0.9", draft: false, prerelease: false },
                { tag_name: "v32.0.12", draft: false, prerelease: false },
                { tag_name: "v33.0.10", draft: true, prerelease: false },
                { tag_name: "v33.1.0-rc1", draft: false, prerelease: true },
            ]),
    });
    const request: typeof fetch = Object.assign(
        (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
            expect(new URL(input instanceof Request ? input.url : input).href).toBe(
                "https://api.github.com/repos/nextcloud/server/releases?per_page=100"
            );
            return fetch(server.url, options);
        },
        { preconnect: fetch.preconnect }
    );
    const cache = new Map<string, Promise<string>>();
    try {
        for (const [installed, available] of [
            ["33.0.0", "33.0.9"],
            ["33.0.9", "34.0.3"],
            ["32.0.0", "32.0.12"],
            ["35.0.0", "35.0.0"],
            ["25.0.0", null],
        ] as const) {
            const result = await resolveUpdates(
                {
                    capturedAt: new Date().toISOString(),
                    repositoryMetadataAt: null,
                    complete: true,
                    coveredKinds: ["application"],
                    items: [
                        {
                            id: "application:nextcloud",
                            name: "Nextcloud",
                            kind: "application",
                            release: "nextcloud",
                            installed,
                            available: null,
                            status: "unknown",
                            security: false,
                            held: false,
                        },
                    ],
                },
                AbortSignal.timeout(2000),
                cache,
                request
            );
            expect(result.items[0]?.available).toBe(available);
            expect(result.items[0]?.candidateVerified).toBe(available !== null);
        }
    } finally {
        await server.stop(true);
    }
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
