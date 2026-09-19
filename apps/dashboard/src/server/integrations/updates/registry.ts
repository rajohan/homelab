import type { UpdateItem } from "@homelab/contracts/updates";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";

const digest = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
const platformSchema = v.object({
    os: v.string(),
    architecture: v.string(),
    variant: v.optional(v.string()),
});
const manifestEntrySchema = v.object({ digest, platform: v.optional(platformSchema) });
const manifestSchema = v.object({
    config: v.optional(v.object({ digest })),
    manifests: v.optional(v.pipe(v.array(manifestEntrySchema), v.maxLength(100))),
});
const accept =
    "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/**
 * Resolve a public image's selected platform to its configuration digest without pulling layers.
 * @param item - Local image ID, configured image reference and actual platform.
 * @param signal - Per-image deadline.
 * @param request - HTTP boundary, replaceable in tests.
 * @returns The remote image ID, or null for pins, unsupported registries and ambiguous platforms.
 */
export async function latestImage(
    item: UpdateItem,
    signal: AbortSignal,
    request: typeof fetch = fetch
): Promise<string | null> {
    if (!item.image || !item.platform || item.image.includes("@")) return null;
    const match =
        /^(?:(?<registry>localhost|[a-z0-9.-]+\.[a-z]+)\/)?(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?$/.exec(
            item.image
        );
    const fields = match?.groups;
    if (!fields?.repository) return null;
    const registry = fields.registry ?? "docker.io";
    const dockerHub =
        registry === "docker.io" ||
        registry === "registry-1.docker.io" ||
        registry === "index.docker.io";
    if (!dockerHub && registry !== "ghcr.io") return null;
    const origin = dockerHub ? "https://registry-1.docker.io" : "https://ghcr.io";
    const repository =
        dockerHub && !fields.repository.includes("/")
            ? "library/" + fields.repository
            : fields.repository;
    let token: string | undefined;
    const read = async (reference: string) => {
        const url = `${origin}/v2/${repository}/manifests/${encodeURIComponent(reference)}`;
        const send = () =>
            request(url, {
                signal,
                redirect: "error",
                headers: {
                    Accept: accept,
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
            });
        let response = await send();
        if (response.status === 401 && !token) {
            const challenge = response.headers.get("www-authenticate") ?? "";
            await response.body?.cancel();
            const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
            const expected = dockerHub
                ? "https://auth.docker.io/token"
                : "https://ghcr.io/token";
            if (!/^Bearer /i.test(challenge) || realm !== expected)
                throw new Error("Unsupported registry authentication challenge");
            const auth = new URL(expected);
            auth.search = new URLSearchParams({
                service: dockerHub ? "registry.docker.io" : "ghcr.io",
                scope: `repository:${repository}:pull`,
            }).toString();
            const result = v.parse(
                v.object({
                    token: v.optional(v.string()),
                    access_token: v.optional(v.string()),
                }),
                await readBoundedJson(await request(auth, { signal, redirect: "error" }))
            );
            token = result.token ?? result.access_token;
            if (!token || token.length > 16_384)
                throw new Error("Registry read token unavailable");
            response = await send();
        }
        return v.parse(manifestSchema, await readBoundedJson(response));
    };
    let manifest = await read(fields.tag ?? "latest");
    if (manifest.manifests) {
        const compatible = manifest.manifests.filter(
            (entry) =>
                entry.platform?.os === item.platform?.os &&
                entry.platform?.architecture === item.platform?.architecture &&
                (entry.platform?.variant ?? "") === (item.platform?.variant ?? "")
        );
        if (compatible.length !== 1 || !compatible[0]) return null;
        manifest = await read(compatible[0].digest);
    }
    return manifest.config?.digest ?? null;
}
