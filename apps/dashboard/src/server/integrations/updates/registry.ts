import type { UpdateItem } from "@homelab/contracts/updates";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";
import { dockerHubVersionTag } from "./dockerHubTags";
import { imageVersionTag, publicImageReference } from "./imageReference";

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
const imageConfigSchema = v.object({
    config: v.object({
        Labels: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
    }),
});
const tagsSchema = v.object({
    tags: v.nullable(
        v.pipe(v.array(v.pipe(v.string(), v.maxLength(128))), v.maxLength(100))
    ),
});
const accept =
    "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

export interface ImageUpdate {
    readonly imageId: string;
    readonly reference: string;
    readonly current: boolean;
    readonly installedVersion?: string;
    readonly availableVersion?: string;
}

/**
 * Resolve public tags or newer stable versions without pulling layers or changing pins.
 * @param item - Installed image, optional tracking tag and actual platform.
 * @param signal - Shared deadline; tag enumeration also has a page bound.
 * @param request - HTTP boundary replaceable by fixtures.
 * @returns A storage-compatible image ID, platform-content comparison and immutable candidate.
 */
export async function resolveImageUpdate(
    item: UpdateItem,
    signal: AbortSignal,
    request: typeof fetch = fetch
): Promise<ImageUpdate | null> {
    if (!item.image || !item.platform) return null;
    const source = publicImageReference(item.image, item.imageTag);
    if (!source) return null;
    let token: string | undefined;
    const read = async (path: string) => {
        const blob = path.startsWith(`/v2/${source.repository}/blobs/`);
        const send = () =>
            request(source.origin + path, {
                signal,
                redirect: blob ? "manual" : "error",
                headers: {
                    Accept: accept,
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
            });
        let response = await send();
        if (response.status === 401 && !token) {
            const challenge = response.headers.get("www-authenticate") ?? "";
            await response.body?.cancel();
            if (
                !/^Bearer /i.test(challenge) ||
                /realm="([^"]+)"/.exec(challenge)?.[1] !== source.authOrigin
            )
                throw new Error("Unsupported registry authentication challenge");
            const auth = new URL(source.authOrigin);
            auth.search = new URLSearchParams({
                service: source.authService,
                scope: `repository:${source.repository}:pull`,
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
        // Registry blobs may live on a CDN. Follow only fixed vendor origins and
        // never forward the repository's bearer token outside its registry.
        let location = new URL(source.origin + path);
        for (
            let hop = 0;
            blob && [301, 302, 303, 307, 308].includes(response.status);
            hop += 1
        ) {
            const next = response.headers.get("location");
            await response.body?.cancel();
            if (!next || hop >= 4)
                throw new Error("Registry blob redirect budget exceeded");
            location = new URL(next, location);
            const origins =
                source.origin === "https://registry-1.docker.io"
                    ? [
                          "https://production.cloudfront.docker.com",
                          "https://production.cloudflare.docker.com",
                          "https://docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
                      ]
                    : ["https://pkg-containers.githubusercontent.com"];
            if (
                location.username ||
                location.password ||
                location.hash ||
                !origins.includes(location.origin)
            )
                throw new Error("Unsupported registry blob redirect");
            response = await request(location, {
                signal,
                redirect: "manual",
                headers: { Accept: "application/json" },
            });
        }
        const contentDigest = v.safeParse(
            digest,
            response.headers.get("docker-content-digest")
        );
        const hasNext = response.headers.has("link");
        const body = await readBoundedJson(response);
        return {
            body,
            hasNext,
            digest: contentDigest.success ? contentDigest.output : null,
        };
    };
    let selectedTag = source.tag;
    const current = imageVersionTag(source.tag);
    if (
        current &&
        item.imageTag === undefined &&
        source.origin === "https://registry-1.docker.io"
    ) {
        selectedTag = await dockerHubVersionTag(
            source.repository,
            source.tag,
            signal,
            request
        );
    } else if (current && item.imageTag === undefined) {
        let last: string | undefined;
        let complete = false;
        let selected = current;
        for (let page = 0; page < 20; page += 1) {
            signal.throwIfAborted();
            const parameters = new URLSearchParams({
                n: "100",
                ...(last ? { last } : {}),
            });
            const response = await read(
                `/v2/${source.repository}/tags/list?${parameters.toString()}`
            );
            const tags = v.parse(tagsSchema, response.body).tags ?? [];
            for (const tag of tags) {
                const candidate = imageVersionTag(tag);
                if (
                    candidate &&
                    candidate.flavor === current.flavor &&
                    candidate.prefix === current.prefix &&
                    Bun.semver.order(candidate.version, selected.version) > 0
                ) {
                    selectedTag = tag;
                    selected = candidate;
                }
            }
            if (!response.hasNext) {
                complete = true;
                break;
            }
            const next = tags.at(-1);
            if (!next || next === last)
                throw new Error("Registry tag pagination did not advance");
            last = next;
        }
        if (!complete) throw new Error("Registry tag catalog exceeds the lookup budget");
    }
    const readManifest = (reference: string) =>
        read(`/v2/${source.repository}/manifests/${encodeURIComponent(reference)}`);
    const selected = await readManifest(selectedTag);
    const platformManifest = async (
        value: v.InferOutput<typeof manifestSchema>,
        identity: string | null
    ) => {
        if (!value.manifests) return { manifest: value, digest: identity };
        const compatible = value.manifests.filter(
            (entry) =>
                entry.platform?.os === item.platform?.os &&
                entry.platform?.architecture === item.platform?.architecture &&
                (entry.platform?.variant ?? "") === (item.platform?.variant ?? "")
        );
        if (compatible.length !== 1 || !compatible[0]) return null;
        const response = await readManifest(compatible[0].digest);
        return {
            manifest: v.parse(manifestSchema, response.body),
            digest: compatible[0].digest,
        };
    };
    const resolved = await platformManifest(
        v.parse(manifestSchema, selected.body),
        selected.digest
    );
    if (!resolved) return null;
    const { manifest, digest: platformDigest } = resolved;
    if (!manifest.config) return null;
    const configurations = new Map<string, unknown>();
    const readConfiguration = async (identity: string): Promise<unknown> => {
        if (!configurations.has(identity)) {
            const response = await read(`/v2/${source.repository}/blobs/${identity}`);
            configurations.set(identity, response.body);
        }
        return configurations.get(identity);
    };
    // Classic Docker stores config IDs. Containerd stores manifest/index IDs.
    // Normalize content for availability, but preserve the daemon's identity kind
    // for the worker's exact post-pull check and its subsequent observation.
    let installedConfig = item.installed;
    let identityKind: "config" | "index" | "manifest" = "config";
    if (item.installed !== manifest.config.digest) {
        if (item.installed === selected.digest || item.installed === platformDigest) {
            installedConfig = manifest.config.digest;
            identityKind = item.installed === platformDigest ? "manifest" : "index";
        } else {
            try {
                v.parse(
                    v.object({
                        os: v.literal(item.platform.os),
                        architecture: v.literal(item.platform.architecture),
                        config: imageConfigSchema.entries.config,
                    }),
                    await readConfiguration(item.installed)
                );
            } catch {
                signal.throwIfAborted();
                const response = await readManifest(item.installed);
                const value = v.parse(manifestSchema, response.body);
                const installed = await platformManifest(value, item.installed);
                if (!installed?.manifest.config) return null;
                installedConfig = installed.manifest.config.digest;
                identityKind = value.manifests ? "index" : "manifest";
            }
        }
    }
    const imageId = {
        index: selected.digest,
        manifest: platformDigest,
        config: manifest.config.digest,
    }[identityKind];
    if (!imageId) return null;
    const labelVersion = async (identity: string): Promise<string | undefined> => {
        if (!v.safeParse(digest, identity).success) return undefined;
        try {
            const config = v.parse(imageConfigSchema, await readConfiguration(identity));
            const label = config.config.Labels?.["org.opencontainers.image.version"];
            return typeof label === "string"
                ? imageVersionTag(label)?.version
                : undefined;
        } catch {
            signal.throwIfAborted();
            // Optional version metadata can disable automatic admission, never image availability.
            return undefined;
        }
    };
    const installedTag = publicImageReference(item.image)?.tag;
    const installedVersion =
        (installedTag ? imageVersionTag(installedTag)?.version : undefined) ??
        (await labelVersion(installedConfig));
    const availableVersion =
        imageVersionTag(selectedTag)?.version ??
        (manifest.config ? await labelVersion(manifest.config.digest) : undefined);
    return {
        imageId,
        current: installedConfig === manifest.config.digest,
        reference: `${source.prefix}:${selectedTag}${selected.digest ? `@${selected.digest}` : ""}`,
        ...(installedVersion ? { installedVersion } : {}),
        ...(availableVersion ? { availableVersion } : {}),
    };
}

/**
 * Resolve a candidate using the observed daemon's config or manifest identity kind.
 * @param item - Local observation.
 * @param signal - Bounded lookup deadline.
 * @param request - HTTP boundary replaceable by fixtures.
 * @returns The expected Docker image ID after pulling, or null when unsupported.
 */
export async function latestImage(
    item: UpdateItem,
    signal: AbortSignal,
    request: typeof fetch = fetch
): Promise<string | null> {
    const candidate = await resolveImageUpdate(item, signal, request);
    return candidate?.imageId ?? null;
}
