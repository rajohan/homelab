import type { UpdateItem } from "@homelab/contracts/updates";
import type { SQL } from "bun";

import { updateActionJobs } from "../integrations/updates/actions";
import { parseUpdateTargets } from "../integrations/updates/configuration";
import type { UpdateExecutor } from "../integrations/updates/execution";
import type { JobHandler } from "../jobs/types";

const connection = {
    source: "demo-main",
    host: "preview.invalid",
    user: "preview",
    identityFile: "/nonexistent/preview-key",
    knownHostsFile: "/nonexistent/preview-hosts",
};

export const previewUpdateTargets = parseUpdateTargets(
    JSON.stringify([
        {
            ...connection,
            id: "demo-packages",
            label: "Demo OS packages",
            driver: { kind: "apt" },
        },
        {
            ...connection,
            id: "demo-web",
            label: "Demo web application",
            driver: {
                kind: "docker",
                name: "demo-web",
                project: "demo",
                service: "web",
                directory: "/nonexistent/demo",
                file: "/nonexistent/demo/compose.yml",
                imageFile: "/nonexistent/demo/compose.yml",
            },
        },
        {
            ...connection,
            id: "demo-failure",
            label: "Demo failed update",
            driver: {
                kind: "native",
                item: "application:demo-failure",
                release: "bun",
                inspect: ["/nonexistent/demo", "--version"],
                install: ["/nonexistent/demo", "install", "{version}"],
                health: ["/nonexistent/demo", "health"],
            },
        },
    ])
);

export const previewUpdateItems: readonly UpdateItem[] = [
    {
        id: "docker:" + "d".repeat(64),
        name: "demo-web",
        kind: "container",
        installed: "sha256:" + "a".repeat(64),
        available: "sha256:" + "b".repeat(64),
        image: "docker.io/example/demo:1.2.0@sha256:" + "c".repeat(64),
        availableImage: "docker.io/example/demo:1.3.0@sha256:" + "e".repeat(64),
        installedVersion: "1.2.0",
        availableVersion: "1.3.0",
        status: "available",
        held: false,
        pinned: true,
        security: false,
        candidateVerified: true,
    },
    {
        id: "application:demo-failure",
        release: "bun",
        name: "Demo failed update",
        kind: "application",
        installed: "1.0.0",
        available: "1.1.0",
        status: "available",
        held: false,
        security: false,
        candidateVerified: true,
    },
];

/**
 * Simulate an installer exclusively inside the disposable preview, including a health failure.
 * @param target - A fixed synthetic target; real host identities are rejected.
 * @param item - The synthetic candidate approved through the normal queue.
 * @param automatic - Retained to exercise the same worker admission path.
 * @param signal - Cancellation from the real worker claim.
 * @param report - The ordinary fenced job-progress sink.
 * @returns A synthetic receipt; no process, SSH connection or host update is performed.
 */
export const executePreviewUpdate: UpdateExecutor = async (
    target,
    item,
    automatic,
    signal,
    report
) => {
    if (target.host !== "preview.invalid" || target.source !== "demo-main")
        throw new Error("Only synthetic update targets are permitted in this fixture");
    for (const message of [
        "Checking the installed version and update target.",
        automatic
            ? "Applying the enabled patch and minor update policy."
            : "Preparing the confirmed version.",
        target.driver.kind === "docker"
            ? "Downloading the approved image."
            : "Downloading the approved package.",
        "Installing the approved version.",
        "Verifying the installed version and application health.",
    ]) {
        signal.throwIfAborted();
        await report(message);
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(new Error("Preview update cancelled"));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, 1200);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
                signal.removeEventListener("abort", abort);
                abort();
            }
        });
    }
    if (target.id === "demo-failure")
        throw new Error("Synthetic application health check failed");
    if (!item.available) throw new Error("Missing synthetic update candidate");
    return {
        installed: item.available,
        rebootRequired: false,
        ...(target.driver.kind === "docker" ? { containerId: "f".repeat(64) } : {}),
    };
};

/**
 * Replace only preview update executors while preserving production job definitions and APIs.
 * @param registry - Ordinary code-owned job registry.
 * @param client - Disposable preview database, never production state.
 * @returns Handlers that cannot connect to update hosts or public registries.
 */
export function previewUpdateJobs(
    registry: ReadonlyMap<string, JobHandler>,
    client: SQL
): JobHandler[] {
    return [
        ...[...registry.values()].filter(
            (job) => !job.definition.key.startsWith("updates.")
        ),
        ...updateActionJobs(previewUpdateTargets, client, executePreviewUpdate),
        ...[...registry.values()]
            .filter((job) => job.definition.key === "updates.releases")
            .map((job) => ({
                definition: job.definition,
                execute: async (
                    _payload: Record<string, unknown>,
                    context: Parameters<JobHandler["execute"]>[1]
                ) => {
                    await context.reportProgress(
                        "Refreshing the synthetic update inventory."
                    );
                    if (
                        !(await context.commit(async (transaction) => {
                            // Preserve completed synthetic updates instead of restoring the initial seed.
                            await transaction`UPDATE operation_snapshots SET value=jsonb_set(jsonb_set(value,'{capturedAt}',to_jsonb(now()::text)),'{repositoryMetadataAt}',to_jsonb(now()::text)), captured_at=now() WHERE key LIKE 'updates:demo-%'`;
                            await transaction`INSERT INTO operation_snapshots(key,value,captured_at) SELECT replace(key,'updates:','updates.resolved:'),value,now() FROM operation_snapshots WHERE key LIKE 'updates:demo-%' ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
                        }))
                    )
                        throw new Error("Preview refresh no longer owns its job");
                },
            })),
    ];
}
