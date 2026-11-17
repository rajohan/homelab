import {
    sourceDependencyConfigSchema,
    type sourceUpdateSchema,
    sourceVersionSchema,
} from "@homelab/contracts/sourceDependencies";
import type { SQL } from "bun";
import * as v from "valibot";

import information from "../../../../../../package.json";
import { readBoundedJson } from "../http/readJson";
import { githubReleaseRequest } from "../updates/github";

const semanticVersion = v.pipe(
    v.string(),
    v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
);
type Source = v.InferOutput<typeof sourceUpdateSchema>;
type Dependency = {
    id: string;
    name: string;
    version: string;
    source: Source | { kind: "canary" };
};

/**
 * Derive every non-Dependabot source pin from the root manifest.
 * @returns Validated Windows, skill and Bun channel observations; missing feeds fail qualification.
 */
export function buildDependencies(): Dependency[] {
    const entries: Dependency[] = [];
    const configuration = v.parse(sourceDependencyConfigSchema, information.config);
    for (const [group, records] of Object.entries(configuration)) {
        for (const [id, value] of Object.entries(records)) {
            const parsed = value;
            entries.push({
                id: `${group}:${id}`,
                name:
                    (
                        {
                            inno: "Inno Setup",
                            webview2: "WebView2 SDK",
                            impeccable: "Impeccable",
                            intent: "Intent",
                        } as Record<string, string>
                    )[id] ?? id,
                version: parsed.version,
                source: parsed.update,
            });
        }
    }
    const bun = information.packageManager.replace(/^bun@/, "");
    v.parse(v.pipe(semanticVersion, v.regex(/^\d+\.\d+\.\d+-canary\.\d{8}\.\d+$/)), bun);
    entries.push({
        id: "runtime:bun",
        name: "Bun Canary",
        version: bun,
        source: { kind: "canary" },
    });
    return entries;
}

const dependencies = buildDependencies();
const fingerprint = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([dependencies, information.config.skills]))
    .digest("hex");

function numericOrder(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference) return difference;
    }
    return 0;
}

function sourceUrl(source: Dependency["source"]): string {
    if (source.kind === "github")
        return `https://github.com/${source.repository}/releases`;
    if (source.kind === "nuget")
        return `https://www.nuget.org/packages/${source.package}`;
    return "https://www.npmjs.com/package/bun?activeTab=versions";
}

async function latest(
    dependency: Dependency,
    signal: AbortSignal,
    request: typeof fetch
) {
    const read = async (url: string) =>
        readBoundedJson(
            await request(url, {
                signal,
                redirect: "error",
                headers: { Accept: "application/json" },
            }),
            262_144
        );
    const source = dependency.source;
    if (source.kind === "github") {
        const release = v.parse(
            v.object({
                tag_name: v.string(),
                draft: v.literal(false),
                prerelease: v.literal(false),
            }),
            await read(
                `https://api.github.com/repos/${source.repository}/releases/latest`
            )
        );
        if (!release.tag_name.startsWith(source.tagPrefix))
            throw new Error("Unsupported release tag.");
        return v.parse(
            sourceVersionSchema,
            release.tag_name
                .slice(source.tagPrefix.length)
                .replaceAll(source.separator, ".")
        );
    }
    if (source.kind === "nuget") {
        const catalog = v.parse(
            v.object({
                versions: v.pipe(
                    v.array(v.pipe(v.string(), v.maxLength(100))),
                    v.maxLength(10_000)
                ),
            }),
            await read(
                `https://api.nuget.org/v3-flatcontainer/${source.package}/index.json`
            )
        );
        const version = catalog.versions
            .filter((value) => v.is(sourceVersionSchema, value))
            .toSorted((left, right) => numericOrder(right, left))[0];
        if (!version) throw new Error("No stable package release.");
        return version;
    }
    const versions = await Promise.all(
        ["linux", "windows"].map(async (platform) => {
            const body = v.parse(
                v.object({ version: semanticVersion }),
                await read(`https://registry.npmjs.org/@oven/bun-${platform}-x64/canary`)
            );
            if (!/^\d+\.\d+\.\d+-canary\.\d{8}\.\d+$/.test(body.version))
                throw new Error("Unexpected Bun channel.");
            return body.version;
        })
    );
    if (versions[0] !== versions[1]) throw new Error("Bun platform releases differ.");
    return versions[0]!;
}

/**
 * Check all manifest-owned upstreams without downloading or executing their packages.
 * @param signal - Scheduled job cancellation and deadline.
 * @param request - Existing GitHub release transport with bounded caching and backoff.
 * @returns Independent current/available/unknown rows, bound to these exact manifest pins.
 */
export async function readBuildDependencies(
    signal: AbortSignal,
    request: typeof fetch = githubReleaseRequest()
) {
    const items = await Promise.all(
        dependencies.map(async (dependency) => {
            const row = {
                id: dependency.id,
                name: dependency.name,
                pinned: dependency.version,
                url: sourceUrl(dependency.source),
            };
            try {
                const available = await latest(
                    dependency,
                    AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
                    request
                );
                const newer =
                    dependency.source.kind === "canary"
                        ? Bun.semver.order(available, dependency.version) > 0
                        : numericOrder(available, dependency.version) > 0;
                return {
                    ...row,
                    available,
                    status: newer ? ("available" as const) : ("current" as const),
                };
            } catch {
                signal.throwIfAborted();
                return { ...row, available: null, status: "unknown" as const };
            }
        })
    );
    return { fingerprint, items };
}

/**
 * Read the last scheduled source check only when it describes the running manifest.
 * @param client - Operations database; no network or package manager is called here.
 * @returns Stored source observations with explicit freshness, or null before the first compatible check.
 */
export async function buildDependencySnapshot(client: SQL) {
    const [snapshot] = await client<
        {
            value: Awaited<ReturnType<typeof readBuildDependencies>>;
            capturedAt: string;
            fresh: boolean;
        }[]
    >`SELECT value, captured_at::text AS "capturedAt", captured_at > now() - interval '2 hours' AS fresh
        FROM operation_snapshots WHERE key = 'homelab.dependencies'`;
    const [lastCheck] = await client<{ state: string }[]>`SELECT state FROM job_runs
        WHERE action = 'homelab.dependencies' AND state NOT IN ('queued', 'running')
        ORDER BY id DESC LIMIT 1`;
    if (snapshot && lastCheck && lastCheck.state !== "succeeded") snapshot.fresh = false;
    return snapshot?.value.fingerprint === fingerprint ? snapshot : null;
}
