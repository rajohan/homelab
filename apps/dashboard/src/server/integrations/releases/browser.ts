import * as v from "valibot";

import { readReleaseAsset } from "./asset";

const manifestSchema = v.object({
    version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/)),
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    platform: v.literal("linux/amd64"),
    images: v.pipe(
        v.array(
            v.object({
                app: v.picklist(["mira-browser", "mira-browser-proxy"]),
                reference: v.string(),
            })
        ),
        v.length(2)
    ),
});
const evidenceSchema = v.object({
    artifacts: v.pipe(
        v.array(
            v.object({
                name: v.string(),
                expired: v.boolean(),
                digest: v.nullable(v.string()),
                workflow_run: v.object({ id: v.number(), head_sha: v.string() }),
            })
        ),
        v.maxLength(100)
    ),
});

/**
 * Read browser and proxy images only when both belong to the verified release workflow attempt.
 * @param options - Trusted release identity and bounded transport; no browser-supplied URL or tag.
 * @returns Both immutable images, or null for absent, incomplete or unverifiable browser publication.
 */
export async function readBrowserRelease(options: {
    repository: string;
    version: string;
    revision: string;
    assets: { id: number; name: string }[];
    build: { id: number; run_attempt: number };
    base: string;
    headers: Record<string, string>;
    read: (path: string) => Promise<unknown>;
    request: typeof fetch;
    signal: AbortSignal;
}) {
    const { repository, version, revision, build, signal } = options;
    const assets = options.assets.filter((asset) => asset.name === "browser-image.json");
    if (assets.length !== 1) return null;
    try {
        const bytes = await readReleaseAsset(
            options.base,
            assets[0]!.id,
            options.headers,
            signal,
            options.request,
            16_384
        );
        const manifest = v.parse(
            manifestSchema,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
        );
        if (
            manifest.version !== version ||
            manifest.revision !== revision ||
            new Set(manifest.images.map((image) => image.app)).size !== 2 ||
            !manifest.images.every((image) => {
                const prefix = `ghcr.io/${repository.toLowerCase()}/${image.app}:${version}@sha256:`;
                return (
                    image.reference.startsWith(prefix) &&
                    /^[a-f0-9]{64}$/.test(image.reference.slice(prefix.length))
                );
            })
        )
            return null;
        const name = `browser-manifest-${build.run_attempt}.json`;
        const evidence = v.parse(
            evidenceSchema,
            await options.read(
                `/actions/runs/${build.id}/artifacts?per_page=100&name=${name}`
            )
        );
        const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
        const matches = evidence.artifacts.filter(
            (artifact) =>
                artifact.name === name &&
                !artifact.expired &&
                artifact.digest === digest &&
                artifact.workflow_run.id === build.id &&
                artifact.workflow_run.head_sha === revision
        );
        return matches.length === 1 ? manifest : null;
    } catch {
        signal.throwIfAborted();
        return null;
    }
}
