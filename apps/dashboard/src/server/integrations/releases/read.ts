import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";
import { readReleaseAsset } from "./asset";
import { readComputerDownload } from "./computer";

const repositorySchema = v.pipe(
    v.string(),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
);
const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const assetDigest = v.optional(v.nullable(v.string()));
const releaseSchema = v.object({
    tag_name: v.pipe(v.string(), v.regex(/^v\d+\.\d+\.\d+$/)),
    draft: v.literal(false),
    prerelease: v.literal(false),
    assets: v.pipe(
        v.array(
            v.object({
                id: v.pipe(v.number(), v.integer(), v.minValue(1)),
                name: v.string(),
                state: v.optional(v.string()),
                size: v.optional(v.number()),
                digest: assetDigest,
            })
        ),
        v.maxLength(100)
    ),
});
const manifestSchema = v.object({
    version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/)),
    revision: sha,
    platform: v.literal("linux/amd64"),
    images: v.pipe(
        v.array(
            v.object({
                app: v.picklist(["auth", "dashboard", "mira"]),
                reference: v.string(),
            })
        ),
        v.minLength(2),
        v.maxLength(3)
    ),
});
const runsSchema = v.object({
    workflow_runs: v.pipe(
        v.array(
            v.object({
                head_sha: sha,
                event: v.string(),
                path: v.string(),
                status: v.string(),
                conclusion: v.nullable(v.string()),
                id: v.number(),
                run_attempt: v.pipe(v.number(), v.integer(), v.minValue(1)),
            })
        ),
        v.maxLength(100)
    ),
});
const artifactsSchema = v.object({
    artifacts: v.pipe(
        v.array(
            v.object({
                name: v.string(),
                expired: v.boolean(),
                digest: v.nullable(v.string()),
                workflow_run: v.object({ id: v.number(), head_sha: sha }),
            })
        ),
        v.maxLength(100)
    ),
});

/**
 * Read an exact published Homelab release and its tested image references without deployment authority.
 * @param repository - Explicit owner/repository; requests never use browser-provided URLs.
 * @param token - Existing worker-only GitHub read credential.
 * @param signal - Bounded read job lifetime.
 * @param request - HTTP transport, replaceable with deterministic fixtures.
 * @returns Version, commit, immutable references and the matching release build result.
 */
export async function readHomelabRelease(
    repository: string,
    token: string | undefined,
    signal: AbortSignal,
    request: typeof fetch = fetch
) {
    v.parse(repositorySchema, repository);
    const base = `https://api.github.com/repos/${repository}`;
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "Homelab",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const read = async (path: string) =>
        readBoundedJson(
            await request(base + path, { headers, signal, redirect: "error" }),
            262_144
        );
    const release = v.parse(releaseSchema, await read("/releases/latest"));
    const assets = release.assets.filter(
        (asset) => asset.name === "container-images.json"
    );
    if (assets.length !== 1)
        throw new Error("Published release has no complete image manifest yet");
    const bytes = await readReleaseAsset(
        base,
        assets[0]!.id,
        headers,
        signal,
        request,
        16_384
    );
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    const manifest = v.parse(
        manifestSchema,
        JSON.parse(new TextDecoder().decode(bytes)) as unknown
    );
    if (
        `v${manifest.version}` !== release.tag_name ||
        new Set(manifest.images.map((image) => image.app)).size !==
            manifest.images.length ||
        !manifest.images.some((image) => image.app === "auth") ||
        !manifest.images.some((image) => image.app === "dashboard") ||
        !manifest.images.every(
            (image) =>
                image.reference.startsWith(
                    `ghcr.io/${repository.toLowerCase()}/${image.app}:${manifest.version}@sha256:`
                ) &&
                /^[a-f0-9]{64}$/.test(
                    image.reference.slice(
                        `ghcr.io/${repository.toLowerCase()}/${image.app}:${manifest.version}@sha256:`
                            .length
                    )
                )
        )
    )
        throw new Error("Release image references do not match the published version");
    const referenceSchema = v.object({
        object: v.object({ type: v.picklist(["commit", "tag"]), sha }),
    });
    let reference = v.parse(
        referenceSchema,
        await read(`/git/ref/tags/${release.tag_name}`)
    ).object;
    if (reference.type === "tag")
        reference = v.parse(
            referenceSchema,
            await read(`/git/tags/${reference.sha}`)
        ).object;
    if (reference.type !== "commit" || reference.sha !== manifest.revision)
        throw new Error("Release tag and image commit differ");
    const runs = v.parse(
        runsSchema,
        await read(
            `/actions/runs?head_sha=${manifest.revision}&event=release&per_page=100`
        )
    );
    const builds = runs.workflow_runs
        .filter(
            (run) =>
                run.head_sha === manifest.revision &&
                run.event === "release" &&
                run.path === ".github/workflows/container-images.yml"
        )
        .toSorted((a, b) => b.id - a.id);
    const build = builds[0];
    let verified = false;
    if (build?.status === "completed" && build.conclusion === "success") {
        const name = `release-manifest-${build.run_attempt}.json`;
        const evidence = v.parse(
            artifactsSchema,
            await read(`/actions/runs/${build.id}/artifacts?per_page=100&name=${name}`)
        );
        const matches = evidence.artifacts.filter(
            (artifact) =>
                artifact.name === name &&
                !artifact.expired &&
                artifact.digest === digest &&
                artifact.workflow_run.id === build.id &&
                artifact.workflow_run.head_sha === manifest.revision
        );
        verified = matches.length === 1;
    }
    const computer =
        verified && build
            ? await readComputerDownload({
                  repository,
                  version: manifest.version,
                  revision: manifest.revision,
                  assets: release.assets,
                  build,
                  base,
                  headers,
                  read,
                  request,
                  signal,
              })
            : null;
    return {
        computer,
        repository,
        version: manifest.version,
        revision: manifest.revision,
        images: manifest.images,
        tests: build?.conclusion ?? build?.status ?? "unknown",
        verified,
        url: `https://github.com/${repository}/releases/tag/${release.tag_name}`,
        buildUrl: build
            ? `https://github.com/${repository}/actions/runs/${build.id}`
            : null,
    };
}

/**
 * Validate optional deployment-owned release reporting configuration.
 * @param value - Repository slug, or undefined to keep external release reporting disabled.
 * @returns The validated repository when explicitly configured.
 */
export function releaseRepository(value: string | undefined): string | undefined {
    return value === undefined ? undefined : v.parse(repositorySchema, value);
}
