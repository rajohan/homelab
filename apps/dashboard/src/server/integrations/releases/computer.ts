import * as v from "valibot";

import { readReleaseAsset } from "./asset";

const manifestSchema = v.object({
    schemaVersion: v.literal(1),
    version: v.pipe(v.string(), v.regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)),
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    platform: v.literal("windows-x64"),
    installer: v.object({
        name: v.string(),
        size: v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(512 * 1024 * 1024)
        ),
        sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    }),
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
 * Project a Windows installer only when its manifest belongs to the tested release workflow attempt.
 * @param options - Already verified stable container release identity and bounded GitHub transport.
 * @returns A manual official download link, or null for legacy, partial or unverifiable Windows assets.
 */
export async function readComputerDownload(options: {
    repository: string;
    version: string;
    revision: string;
    assets: {
        id: number;
        name: string;
        state?: string | undefined;
        size?: number | undefined;
        digest?: string | null | undefined;
    }[];
    build: { id: number; run_attempt: number };
    base: string;
    headers: Record<string, string>;
    read: (path: string) => Promise<unknown>;
    request: typeof fetch;
    signal: AbortSignal;
}) {
    const { repository, version, revision, build, signal } = options;
    const stem = `mira-computer-${version}-windows-x64`;
    const manifests = options.assets.filter((asset) => asset.name === `${stem}.json`);
    const installers = options.assets.filter(
        (asset) => asset.name === `${stem}-setup.exe`
    );
    if (manifests.length !== 1 || installers.length !== 1) return null;
    try {
        const bytes = await readReleaseAsset(
            options.base,
            manifests[0]!.id,
            options.headers,
            signal,
            options.request,
            1024 * 1024
        );
        const manifest = v.parse(
            manifestSchema,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
        );
        const installer = installers[0]!;
        if (
            manifest.version !== version ||
            manifest.revision !== revision ||
            manifest.installer.name !== installer.name ||
            installer.state !== "uploaded" ||
            installer.size !== manifest.installer.size ||
            installer.digest !== `sha256:${manifest.installer.sha256}`
        )
            return null;
        const name = `computer-manifest-${build.run_attempt}.json`;
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
        if (matches.length !== 1) return null;
        return {
            version,
            revision,
            size: manifest.installer.size,
            sha256: manifest.installer.sha256,
            url: `https://github.com/${repository}/releases/download/v${version}/${installer.name}`,
        };
    } catch {
        signal.throwIfAborted();
        // Windows publication may be absent or incomplete without invalidating the container release.
        return null;
    }
}
