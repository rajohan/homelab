import { readBoundedJson } from "../http/readJson";

export interface DockerHubCredential {
    readonly username: string;
    readonly token: string;
}

/**
 * Authenticate Docker Hub pull-token exchanges and reuse bounded registry metadata.
 * @param credential - Optional worker-only Docker Hub username and access token.
 * @param request - HTTP transport; credentials never reach arbitrary origins or redirects.
 * @param now - Clock for metadata expiry and provider backoff.
 * @returns A fetch-compatible registry client shared by all update check jobs.
 */
export function registryRequest(
    credential?: DockerHubCredential,
    request: typeof fetch = fetch,
    now: () => number = Date.now
): typeof fetch {
    const cache = new Map<
        string,
        { body: string; headers: Headers; expiresAt: number; size: number }
    >();
    const blocked = new Map<string, number>();
    let bytes = 0;
    return Object.assign(
        async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
        ) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const method = (
                init?.method ?? (input instanceof Request ? input.method : "GET")
            ).toUpperCase();
            const safe = !url.username && !url.password && method === "GET";
            const exchange =
                safe &&
                url.origin === "https://auth.docker.io" &&
                url.pathname === "/token" &&
                url.searchParams.getAll("service").length === 1 &&
                url.searchParams.get("service") === "registry.docker.io" &&
                url.searchParams.getAll("scope").length === 1 &&
                /^repository:[a-z0-9][a-z0-9._/-]*:pull$/.test(
                    url.searchParams.get("scope") ?? ""
                ) &&
                [...url.searchParams.keys()].every(
                    (key) => key === "service" || key === "scope"
                );
            const metadata =
                safe &&
                ((["https://registry-1.docker.io", "https://ghcr.io"].includes(
                    url.origin
                ) &&
                    /^\/v2\/.+\/(?:manifests|blobs|tags)\//.test(url.pathname)) ||
                    (url.origin === "https://hub.docker.com" &&
                        /^\/v2\/namespaces\/[^/]+\/repositories\/[^/]+\/tags\/?$/.test(
                            url.pathname
                        )));
            if (!exchange && !metadata) return request(input, init);
            const signal =
                init?.signal ?? (input instanceof Request ? input.signal : undefined);
            signal?.throwIfAborted();
            const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined)
            );
            if (exchange && credential)
                headers.set(
                    "Authorization",
                    "Basic " +
                        Buffer.from(
                            `${credential.username}:${credential.token}`
                        ).toString("base64")
                );
            // Keep cache identity independent of short-lived bearer tokens. A client instance
            // belongs to one worker configuration and never mixes different credentials.
            const key = url.href + " " + (headers.get("Accept") ?? "");
            const saved = cache.get(key);
            if (saved && saved.expiresAt > now())
                return new Response(saved.body, { headers: saved.headers });
            const provider = exchange ? "https://registry-1.docker.io" : url.origin;
            if ((blocked.get(provider) ?? 0) > now())
                return new Response(null, { status: 429 });
            const response = await request(input, {
                ...init,
                headers,
                ...(exchange ? { redirect: "error" as const } : {}),
            });
            if (response.status === 429) {
                const retry = response.headers.get("retry-after");
                const deadline =
                    retry && /^\d+$/.test(retry)
                        ? now() + Number(retry) * 1000
                        : Date.parse(retry ?? "");
                blocked.set(
                    provider,
                    now() +
                        Math.max(
                            60_000,
                            Math.min(
                                21_600_000,
                                Number.isFinite(deadline) ? deadline - now() : 60_000
                            )
                        )
                );
            }
            if (response.status !== 200) return response;
            const body: unknown = await readBoundedJson(response);
            signal?.throwIfAborted();
            const serialized = JSON.stringify(body);
            const size = Buffer.byteLength(serialized);
            let ttl = 600_000;
            if (exchange) {
                const expires =
                    body && typeof body === "object" && "expires_in" in body
                        ? Number(body.expires_in)
                        : 60;
                ttl =
                    Number.isFinite(expires) && expires > 0
                        ? Math.min(60_000, expires * 500)
                        : 0;
            }
            if (saved) {
                cache.delete(key);
                bytes -= saved.size;
            }
            while (cache.size > 0 && (bytes + size > 8_000_000 || cache.size >= 128)) {
                const oldest = cache.keys().next().value!;
                bytes -= cache.get(oldest)!.size;
                cache.delete(oldest);
            }
            const responseHeaders = new Headers();
            for (const name of ["Content-Type", "Docker-Content-Digest", "Link"]) {
                const value = response.headers.get(name);
                if (value) responseHeaders.set(name, value);
            }
            cache.set(key, {
                body: serialized,
                headers: responseHeaders,
                expiresAt: now() + ttl,
                size,
            });
            bytes += size;
            return new Response(serialized, { headers: responseHeaders });
        },
        { preconnect: request.preconnect }
    );
}
