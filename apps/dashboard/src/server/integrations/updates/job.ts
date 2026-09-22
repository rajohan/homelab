import type { UpdateItem, UpdateReport, UpdateSource } from "@homelab/contracts/updates";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import { enqueueJob } from "../../jobs/queue";
import type { JobDefinition, JobHandler } from "../../jobs/types";
import { resolveImageUpdate, type ImageUpdate } from "./registry";
import { compareRelease, latestRelease } from "./releases";

async function cachedLookup<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    signal: AbortSignal,
    started: number,
    lookup: (deadline: AbortSignal) => Promise<T>
): Promise<T> {
    let promise = cache.get(key);
    if (!promise) {
        const attempt = () => {
            signal.throwIfAborted();
            const remaining = 30_000 - (Date.now() - started);
            if (remaining <= 0) throw new Error("Source lookup budget reached");
            return lookup(
                AbortSignal.any([signal, AbortSignal.timeout(Math.min(8000, remaining))])
            );
        };
        // Share one bounded retry with every identical observation. A temporary
        // registry failure must not leave an otherwise current image unchecked
        // until the next hourly run; cancellation and source budgets still apply.
        promise = attempt().catch(() => attempt());
        cache.set(key, promise);
    }
    return promise;
}

/**
 * Compare observed versions with official releases, isolating individual lookup failures.
 * @param report - Installed inventory from a registered read-only publisher.
 * @param signal - Job deadline and cancellation.
 * @param releases - Per-job feed cache shared across hosts, never across worker runs.
 * @param request - HTTP boundary replaceable with isolated registry/feed fixtures.
 * @returns A new report with unavailable feeds explicit, never guessed up to date.
 */
export async function resolveUpdates(
    report: UpdateReport,
    signal: AbortSignal,
    releases: Map<string, Promise<string>> = new Map(),
    request: typeof fetch = fetch
): Promise<UpdateReport> {
    const images = new Map<string, Promise<ImageUpdate | null>>();
    const items: UpdateItem[] = report.items.map((item) => ({
        ...item,
        candidateVerified: false,
    }));
    const started = Date.now();
    let index = 0;
    const lane = async () => {
        while (index < report.items.length) {
            const position = index++;
            const item = report.items[position];
            if (!item) return;
            signal.throwIfAborted();
            if (!item.release && !item.image) {
                continue;
            }
            try {
                if (Date.now() - started > 30_000)
                    throw new Error("Source lookup budget reached");
                let available: string | null;
                let availableImage: string | undefined;
                let installedVersion: string | undefined;
                let availableVersion: string | undefined;
                let imageCurrent: boolean | undefined;
                if (item.release) {
                    const key =
                        item.release === "nextcloud"
                            ? JSON.stringify([item.release, item.installed])
                            : item.release;
                    const release = item.release;
                    available = await cachedLookup(
                        releases,
                        key,
                        signal,
                        started,
                        (deadline) =>
                            latestRelease(release, deadline, request, item.installed)
                    );
                } else {
                    const key = JSON.stringify([
                        item.image,
                        item.installed,
                        item.imageTag,
                        item.platform,
                    ]);
                    const candidate = await cachedLookup(
                        images,
                        key,
                        signal,
                        started,
                        (deadline) => resolveImageUpdate(item, deadline, request)
                    );
                    available = candidate?.imageId ?? null;
                    availableImage = candidate?.reference;
                    installedVersion = candidate?.installedVersion;
                    availableVersion = candidate?.availableVersion;
                    imageCurrent = candidate?.current;
                }
                let status: UpdateItem["status"] = "unknown";
                if (available !== null)
                    status =
                        (imageCurrent ?? available === item.installed)
                            ? "current"
                            : "available";
                if (available !== null && item.release)
                    status = compareRelease(item.installed, available);
                const {
                    availableImage: _previous,
                    installedVersion: _installed,
                    availableVersion: _version,
                    ...observation
                } = item;
                items[position] = {
                    ...observation,
                    available,
                    status,
                    candidateVerified: available !== null,
                    ...(installedVersion ? { installedVersion } : {}),
                    ...(availableVersion ? { availableVersion } : {}),
                    ...(item.kind === "container" && item.image?.includes("@")
                        ? {
                              pinned: true,
                              held: item.pinned === undefined ? false : item.held,
                          }
                        : {}),
                    ...(availableImage ? { availableImage } : {}),
                };
            } catch {
                signal.throwIfAborted();
                const {
                    availableImage: _previous,
                    installedVersion: _installed,
                    availableVersion: _version,
                    ...observation
                } = item;
                items[position] = {
                    ...observation,
                    candidateVerified: false,
                    available: null,
                    status: "unknown",
                };
            }
        }
    };
    await Promise.all(Array.from({ length: 4 }, lane));
    return { ...report, items };
}

/**
 * Coalesce automatic release checks while retaining a follow-up to running work.
 * @param transaction - Queue-locked dashboard transaction, shared with its triggering write.
 * @param definition - The registered read-only update-check policy.
 * @param key - Stable identity of the accepted publication or superseded check.
 * @returns Completion after queue admission, or no change when queued/disabled.
 */
export async function queueUpdateCheck(
    transaction: TransactionSQL,
    definition: JobDefinition,
    key: string
): Promise<void> {
    const [schedule] = await transaction<{ enabled: boolean }[]>`
        SELECT enabled FROM job_schedules WHERE action = 'updates.releases'`;
    const [pending] = await transaction<{ id: string }[]>`
        SELECT id FROM job_runs WHERE action = 'updates.releases' AND state = 'queued' LIMIT 1`;
    // A queued checker reads the newest reports. A running one may already have
    // read this source, so do not let it suppress a needed follow-up.
    if (schedule?.enabled !== false && !pending)
        await enqueueJob(transaction, definition, "system:updates", key);
}

/**
 * Register read-only release lookups for hourly and publication-triggered checks.
 * @param sources - Exact expected publishers.
 * @param client - Dashboard-only state.
 * @param request - Release/registry HTTP boundary, replaceable with loopback fixtures.
 * @returns A bounded read-only update checker; installation remains separate.
 */
export function updatesJob(
    sources: readonly UpdateSource[],
    client: SQL,
    request: typeof fetch = fetch
): JobHandler {
    const handler: JobHandler = {
        definition: {
            key: "updates.releases",
            label: "Check available updates",
            description:
                "Compare observed software versions and public image tags without installing updates.",
            resourceClass: "network",
            capability: "updates:refresh",
            resourceKeys: ["snapshot:updates"],
            timeoutMs: 120_000,
            attemptLimit: 2,
            retrySafe: true,
            intervalSeconds: 3600,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_payload, context) => {
            const releases = new Map<string, Promise<string>>();
            const history = await client<
                { key: string; time: number }[]
            >`SELECT key, extract(epoch FROM captured_at)::float8 AS time FROM operation_snapshots WHERE key LIKE 'updates.resolved:%'`;
            const lastChecked = (id: string) =>
                history.find((row) => row.key === `updates.resolved:${id}`)?.time ?? 0;
            for (const source of [...sources].toSorted(
                (left, right) => lastChecked(left.id) - lastChecked(right.id)
            )) {
                const [row] = await client<
                    { value: UpdateReport }[]
                >`SELECT value FROM operation_snapshots WHERE key = ${`updates:${source.id}`} AND captured_at > now() - interval '26 hours'`;
                if (!row) continue;
                await context.reportProgress(
                    `Checking available versions for ${source.label}.`
                );
                const report = await resolveUpdates(
                    row.value,
                    context.signal,
                    releases,
                    request
                );
                if (
                    !(await context.commit(async (transaction) => {
                        // Receipts change installed versions without changing the
                        // publisher timestamp. Fence the complete observation,
                        // locking raw then resolved just like receipt persistence.
                        const [unchanged] = await transaction<
                            { key: string }[]
                        >`SELECT key FROM operation_snapshots WHERE key = ${`updates:${source.id}`} AND value = ${JSON.stringify(row.value)}::text::jsonb FOR UPDATE`;
                        if (!unchanged) {
                            await queueUpdateCheck(
                                transaction,
                                handler.definition,
                                `updates-superseded:${context.runId}:${source.id}:${new Bun.CryptoHasher("sha256").update(JSON.stringify(row.value)).digest("hex")}`
                            );
                            return;
                        }
                        await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${`updates.resolved:${source.id}`}, ${JSON.stringify(report)}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                    }, true))
                )
                    throw new Error("Update checker ownership changed");
            }
        },
    };
    return handler;
}
