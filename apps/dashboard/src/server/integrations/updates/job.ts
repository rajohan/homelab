import type { UpdateItem, UpdateReport, UpdateSource } from "@homelab/contracts/updates";
import type { SQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import { resolveImageUpdate, type ImageUpdate } from "./registry";
import { compareRelease, latestRelease } from "./releases";

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
                const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
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
                    let promise = releases.get(key);
                    if (!promise) {
                        promise = latestRelease(
                            item.release,
                            deadline,
                            request,
                            item.installed
                        );
                        releases.set(key, promise);
                    }
                    available = await promise;
                } else {
                    const key = JSON.stringify([
                        item.image,
                        item.installed,
                        item.imageTag,
                        item.platform,
                    ]);
                    let promise = images.get(key);
                    if (!promise) {
                        promise = resolveImageUpdate(item, deadline, request);
                        images.set(key, promise);
                    }
                    const candidate = await promise;
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
 * Register release lookups independently of publisher delivery or application control.
 * @param sources - Exact expected publishers.
 * @param client - Dashboard-only state.
 * @returns An hourly read-only update checker.
 */
export function updatesJob(sources: readonly UpdateSource[], client: SQL): JobHandler {
    return {
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
                const report = await resolveUpdates(row.value, context.signal, releases);
                if (
                    !(await context.commit(async (transaction) => {
                        await transaction`INSERT INTO operation_snapshots (key, value, captured_at) SELECT ${`updates.resolved:${source.id}`}, ${JSON.stringify(report)}::text::jsonb, now() WHERE EXISTS (SELECT 1 FROM operation_snapshots WHERE key = ${`updates:${source.id}`} AND value->>'capturedAt' = ${report.capturedAt}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                    }))
                )
                    throw new Error("Update checker ownership changed");
            }
        },
    };
}
