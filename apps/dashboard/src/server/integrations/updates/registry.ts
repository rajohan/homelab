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
    readonly installedVersion?: string;
    readonly availableVersion?: string;
}

/**
 * Resolve public tags or newer stable versions without pulling layers or changing pins.
 * @param item - Installed image, optional tracking tag and actual platform.
 * @param signal - Shared deadline; tag enumeration also has a page bound.
 * @param request - HTTP boundary replaceable by fixtures.
 * @returns Platform image ID and candidate reference, or null if unsupported or ambiguous.
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
        const send = () =>
            request(source.origin + path, {
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
    let manifest = v.parse(manifestSchema, selected.body);
    if (manifest.manifests) {
        const compatible = manifest.manifests.filter(
            (entry) =>
                entry.platform?.os === item.platform?.os &&
                entry.platform?.architecture === item.platform?.architecture &&
                (entry.platform?.variant ?? "") === (item.platform?.variant ?? "")
        );
        if (compatible.length !== 1 || !compatible[0]) return null;
        const platform = await readManifest(compatible[0].digest);
        manifest = v.parse(manifestSchema, platform.body);
    }
    const labelVersion = async (identity: string): Promise<string | undefined> => {
        if (!v.safeParse(digest, identity).success) return undefined;
        try {
            const response = await read(`/v2/${source.repository}/blobs/${identity}`);
            const config = v.parse(imageConfigSchema, response.body);
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
        (await labelVersion(item.installed));
    const availableVersion =
        imageVersionTag(selectedTag)?.version ??
        (manifest.config ? await labelVersion(manifest.config.digest) : undefined);
    return manifest.config
        ? {
              imageId: manifest.config.digest,
              reference: `${source.prefix}:${selectedTag}${selected.digest ? `@${selected.digest}` : ""}`,
              ...(installedVersion ? { installedVersion } : {}),
              ...(availableVersion ? { availableVersion } : {}),
          }
        : null;
}

/**
 * Compare a selected platform's image ID, including configured digest pins.
 * @param item - Local observation.
 * @param signal - Bounded lookup deadline.
 * @param request - HTTP boundary replaceable by fixtures.
 * @returns Remote image ID, or null if comparison is unsupported.
 */
export async function latestImage(
    item: UpdateItem,
    signal: AbortSignal,
    request: typeof fetch = fetch
): Promise<string | null> {
    const candidate = await resolveImageUpdate(item, signal, request);
    return candidate?.imageId ?? null;
}
