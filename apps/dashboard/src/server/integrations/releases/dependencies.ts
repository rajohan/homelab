import {
    sourceDependencyConfigSchema,
    type sourceUpdateSchema,
    sourceVersionSchema,
} from "@homelab/contracts/sourceDependencies";
import type { SQL } from "bun";
import * as v from "valibot";

import information from "../../../../../../package.json";
import { enqueueJob, lockQueue } from "../../jobs/queue";
import type { JobDefinition } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import { readBoundedJson } from "../http/readJson";
import { githubReleaseRequest } from "../updates/github";

const stableBunVersion = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/));
type Source = v.InferOutput<typeof sourceUpdateSchema>;
type Dependency = {
    id: string;
    name: string;
    version: string;
    source: Source | { kind: "bun" };
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
    v.parse(stableBunVersion, bun);
    entries.push({
        id: "runtime:bun",
        name: "Bun",
        version: bun,
        source: { kind: "bun" },
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

function pinnedRow(dependency: Dependency) {
    return {
        id: dependency.id,
        name: dependency.name,
        pinned: dependency.version,
        url: sourceUrl(dependency.source),
    };
}

/** Show the deployed pins while their first compatible observation is pending. */
export const pendingBuildDependencies = dependencies.map((dependency) => ({
    ...pinnedRow(dependency),
    available: null,
    status: "unknown" as const,
}));

async function latest(
    dependency: Dependency,
    signal: AbortSignal,
    request: typeof fetch
) {
    const read = async (url: string, maximumBytes = 262_144) =>
        readBoundedJson(
            await request(url, {
                signal,
                redirect: "error",
                headers: { Accept: "application/json" },
            }),
            maximumBytes
        );
    const source = dependency.source;
    if (source.kind === "github") {
        const releases = v.parse(
            v.pipe(
                v.array(
                    v.object({
                        tag_name: v.string(),
                        draft: v.boolean(),
                        prerelease: v.boolean(),
                    })
                ),
                v.maxLength(100)
            ),
            await read(
                `https://api.github.com/repos/${source.repository}/releases?per_page=100`,
                2_000_000
            )
        );
        const version = releases
            .filter(
                (release) =>
                    !release.draft &&
                    !release.prerelease &&
                    release.tag_name.startsWith(source.tagPrefix)
            )
            .map((release) =>
                release.tag_name
                    .slice(source.tagPrefix.length)
                    .replaceAll(source.separator, ".")
            )
            .filter((value) => v.is(sourceVersionSchema, value))
            .toSorted((left, right) => numericOrder(right, left))[0];
        if (!version) throw new Error("No matching stable package release.");
        return version;
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
                v.object({ version: stableBunVersion }),
                await read(`https://registry.npmjs.org/@oven/bun-${platform}-x64/latest`)
            );
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
            const row = pinnedRow(dependency);
            try {
                const available = await latest(
                    dependency,
                    AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
                    request
                );
                const newer = numericOrder(available, dependency.version) > 0;
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

/**
 * Admit a normal source check when this worker has no usable manifest observation.
 * @param client - The worker's operations database.
 * @param definition - The registered source dependency job.
 * @param startup - Refresh an already complete but aged snapshot when the worker starts.
 * @returns Whether startup reconciliation can yield to the operator's configured cadence.
 */
export async function queuePendingBuildDependencyCheck(
    client: SQL,
    definition: JobDefinition,
    startup: boolean
): Promise<boolean> {
    return client.begin(async (transaction) => {
        await lockQueue(transaction);
        const [schedule] = await transaction<
            { id: string }[]
        >`SELECT id FROM job_schedules
            WHERE action = ${definition.key} AND enabled
            AND NOT EXISTS (SELECT 1 FROM worker_control WHERE id = 1 AND paused)
            AND NOT EXISTS (SELECT 1 FROM job_runs WHERE action = ${definition.key} AND state IN ('queued', 'running'))`;
        if (!schedule) return false;
        const [snapshot] = await transaction<
            { fresh: boolean; partial: boolean }[]
        >`SELECT
            captured_at > now() - interval '2 hours' AS fresh,
            value->'items' @> '[{"status":"unknown"}]'::jsonb AS partial
            FROM operation_snapshots WHERE key = ${definition.key} AND value->>'fingerprint' = ${fingerprint}`;
        const [last] = await transaction<
            { id: string; state: string; key: string; recent: boolean }[]
        >`SELECT
            id, state, idempotency_key AS key, finished_at > now() - interval '5 minutes' AS recent
            FROM job_runs WHERE action = ${definition.key} ORDER BY id DESC LIMIT 1`;
        if (
            snapshot &&
            (!startup || snapshot.fresh) &&
            !snapshot.partial &&
            (!last || last.state === "succeeded")
        )
            return true;
        const prefix = `dependency-refresh:${fingerprint}:`;
        if (last?.recent && (snapshot || last.key.startsWith(prefix))) return false;
        try {
            await enqueueJob(
                transaction,
                definition,
                "system:scheduler",
                prefix + (last?.id ?? "initial")
            );
            return true;
        } catch (error) {
            if (
                !(error instanceof OperationFailure && error.code === "TOO_MANY_REQUESTS")
            )
                throw error;
            return false;
        }
    });
}
