import { readBoundedJson } from "../http/readJson";

/**
 * Restrict a server-owned GitHub credential to official release metadata requests.
 * @param token - Optional Doppler-delivered credential; never persisted in cached responses.
 * @param request - HTTP boundary used by release checks and replaced in isolated tests.
 * @param now - Clock used for metadata expiration and provider backoff.
 * @returns A fetch-compatible client with bounded release caching and rate-limit backoff.
 */
export function githubReleaseRequest(
    token?: string,
    request: typeof fetch = fetch,
    now: () => number = Date.now
): typeof fetch {
    const cache = new Map<string, { body: unknown; expiresAt: number }>();
    let blockedUntil = 0;
    return Object.assign(
        async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
        ) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const eligible =
                url.origin === "https://api.github.com" &&
                !url.username &&
                !url.password &&
                /^\/repos\/[^/]+\/[^/]+\/releases(?:\/latest)?$/.test(url.pathname) &&
                (
                    init?.method ?? (input instanceof Request ? input.method : "GET")
                ).toUpperCase() === "GET";
            if (!eligible) return request(input, init);
            const signal =
                init?.signal ?? (input instanceof Request ? input.signal : undefined);
            signal?.throwIfAborted();
            const saved = cache.get(url.href);
            if (saved && saved.expiresAt > now()) return Response.json(saved.body);
            if (now() < blockedUntil) return new Response(null, { status: 429 });
            const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined)
            );
            if (token) headers.set("Authorization", `Bearer ${token}`);
            const response = await request(input, {
                ...init,
                headers,
                redirect: "error",
            });
            if (response.status === 403 || response.status === 429) {
                const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
                const retryHeader = response.headers.get("retry-after");
                const retry =
                    retryHeader && /^\d+$/.test(retryHeader)
                        ? now() + Number(retryHeader) * 1000
                        : Date.parse(retryHeader ?? "");
                const deadline =
                    response.headers.get("x-ratelimit-remaining") === "0" && reset > now()
                        ? reset
                        : retry;
                blockedUntil =
                    now() +
                    Math.max(
                        60_000,
                        Math.min(
                            3_600_000,
                            Number.isFinite(deadline) ? deadline - now() : 60_000
                        )
                    );
                return response;
            }
            if (!response.ok) return response;
            const body = await readBoundedJson(response);
            signal?.throwIfAborted();
            if (cache.size >= 32) cache.delete(cache.keys().next().value!);
            cache.set(url.href, { body, expiresAt: now() + 600_000 });
            return Response.json(body);
        },
        { preconnect: request.preconnect }
    );
}
