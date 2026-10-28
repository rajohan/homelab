import { readBoundedBytes } from "../http/readJson";

/**
 * Fetch a bounded release asset without forwarding the GitHub credential to storage redirects.
 * @param base - Validated GitHub repository API base supplied by the release reader.
 * @param id - Positive GitHub asset identity.
 * @param headers - API-only request headers, including an optional read credential.
 * @param signal - Release job deadline.
 * @param request - Injectable HTTP transport.
 * @param maximumBytes - Hard limit for the passive manifest.
 * @returns Exact manifest bytes for provenance validation.
 */
export async function readReleaseAsset(
    base: string,
    id: number,
    headers: Record<string, string>,
    signal: AbortSignal,
    request: typeof fetch,
    maximumBytes: number
): Promise<Uint8Array> {
    let response = await request(`${base}/releases/assets/${id}`, {
        headers: { ...headers, Accept: "application/octet-stream" },
        signal,
        redirect: "manual",
    });
    for (
        let redirects = 0;
        response.status >= 300 && response.status < 400;
        redirects += 1
    ) {
        const destination = new URL(response.headers.get("location") ?? "", base);
        await response.body?.cancel();
        if (
            redirects >= 3 ||
            destination.protocol !== "https:" ||
            destination.port ||
            destination.username ||
            destination.password ||
            ![
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
            ].includes(destination.hostname)
        )
            throw new Error("Unexpected release asset redirect");
        response = await request(destination.href, {
            signal,
            redirect: "manual",
            headers: { Accept: "application/json" },
        });
    }
    return await readBoundedBytes(response, maximumBytes);
}
