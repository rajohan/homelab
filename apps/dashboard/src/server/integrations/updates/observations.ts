import type {
    ApplicationInventory,
    ManagedApplication,
} from "@homelab/contracts/applications";
import type { UpdateReport } from "@homelab/contracts/updates";

import type { Transaction } from "../../database/connection";
import {
    applicationHostResourceKeys,
    type ApplicationTarget,
} from "../applications/configuration";
import { boundHostSources } from "../hostBindings";
import type { UpdateTarget } from "./configuration";

const codeFile =
    /\.(?:py|pyc|js|mjs|cjs|jsx|ts|tsx|so|node|sh|bash|dash|ksh|zsh|fish|pl|rb|php|lua|ps1|exe|dll|wasm|jar|class|jmod|java)$/i;
const codeDirectory =
    /^(?:\/app(?:\/(?:src|lib|services|providers|api|utils|cw_platform)(?:\/.*)?)?|\/(?:usr\/(?:local\/)?)?(?:bin|sbin|libexec|lib|lib32|lib64)(?:\/.*)?|\/usr\/share\/(?:nodejs|node_modules|python\d*(?:\.\d+)*|perl\d*|php|ruby)(?:\/.*)?)\/?$/;
const overlayReason =
    "Local application code is mounted over this image. Review or remove the override before updating.";
type DockerOwner = Pick<
    Extract<UpdateTarget["driver"], { kind: "docker" }>,
    "name" | "project" | "service"
>;

/**
 * Detect mounted application code that cannot be qualified by changing an image pin.
 * @param application - Safe Docker metadata, excluding environment and file contents.
 * @returns Whether a source overlay requires a separately qualified deployment.
 */
export function hasApplicationCodeMount(application: ManagedApplication): boolean {
    return application.mounts.some(
        (mount) =>
            mount.destination !== "/opt/homelab/logout-worker.js" &&
            (mount.startupCode === true ||
                codeFile.test(mount.destination) ||
                codeDirectory.test(mount.destination))
    );
}

/**
 * Refresh same-image container identities without carrying consent across a replacement.
 * @param report - Existing software publication or compatible release resolution.
 * @param applications - Current, explicitly bound project inventory.
 * @param owners - Configured Compose owners for this source, not unbound recipes.
 * @returns A report whose changed identities invalidate old confirmation revisions.
 */
export function reconcileDockerObservations(
    report: UpdateReport,
    applications: readonly ManagedApplication[],
    owners: readonly DockerOwner[]
): UpdateReport {
    return {
        ...report,
        items: report.items.map((item) => {
            if (item.kind !== "container") return item;
            const configured = owners.filter((owner) => owner.name === item.name);
            if (
                new Set(
                    configured.map((owner) =>
                        JSON.stringify([owner.project, owner.service])
                    )
                ).size !== 1
            )
                return item;
            const owner = configured[0]!;
            const matches = applications.filter((app) => app.containerName === item.name);
            if (matches.length !== 1) return item;
            const app = matches[0]!;
            if (app.project !== owner.project || app.name !== owner.service) return item;
            // Recompute only discovery-owned blocks. Publisher refusals retain
            // their provenance even when a code overlay is added or removed.
            const { applicationBlock: _block, ...previous } = item;
            if (app.image !== item.image || app.imageId !== item.installed)
                return {
                    ...previous,
                    candidateVerified: false,
                    available: null,
                    status: "unknown" as const,
                    applicationBlock:
                        "The installed image changed. Refresh the host software inventory before updating.",
                };
            return {
                ...previous,
                id: `docker:${app.containerId}`,
                ...(hasApplicationCodeMount(app)
                    ? { applicationBlock: overlayReason }
                    : {}),
            };
        }),
    };
}

/**
 * Keep daily software reports aligned with minute-level application discovery.
 * @param transaction - Discovery's fenced transaction, already holding the queue lock.
 * @param inventory - Successful observations carrying a pre-read watermark for each host.
 * @param applications - Current explicit host/project/source bindings.
 * @param targets - Recipes defining physical-host aliases and exact Compose ownership.
 * @returns After updating raw then resolved reports; active host operations are never disturbed.
 */
export async function refreshDockerObservations(
    transaction: Transaction,
    inventory: ApplicationInventory,
    applications: readonly ApplicationTarget[],
    targets: readonly UpdateTarget[]
): Promise<void> {
    const snapshots = new Map<
        string,
        {
            value: UpdateReport;
            original: string;
            capturedAt: string;
            mutatedAt: string;
            mutationXid: string;
            applications: ManagedApplication[];
            owners: DockerOwner[];
        } | null
    >();
    for (const host of inventory.hosts) {
        const binding = applications.find((target) => target.id === host.id);
        const startedAt = host.observationStartedAt;
        const visibility = host.observationVisibility;
        if (
            !binding ||
            !host.available ||
            !startedAt ||
            !visibility ||
            !Number.isFinite(Date.parse(startedAt))
        )
            continue;
        const sources = boundHostSources(
            binding.updateSources ?? [binding.id],
            targets,
            applications
        );
        const keys = applicationHostResourceKeys(binding);
        const [active] = await transaction<{ active: boolean }[]>`
            SELECT EXISTS(SELECT 1 FROM resource_leases WHERE key = ANY(${transaction.array([...keys], "TEXT")}::text[])) AS active`;
        if (active?.active) continue;
        const allowed = host.applications.filter((app) =>
            binding.projects.includes(app.project)
        );
        const recipes = targets.filter((target) => sources.includes(target.source));
        // Receipt persistence takes the same raw-before-resolved order. Do not
        // advance publication timestamps or rewrite already queued confirmations.
        for (const prefix of ["updates:", "updates.resolved:"]) {
            for (const source of sources) {
                const key = `${prefix}${source}`;
                if (!snapshots.has(key)) {
                    const [stored] = await transaction<
                        {
                            value: UpdateReport;
                            capturedAt: string;
                            mutatedAt: string;
                            mutationXid: string;
                        }[]
                    >`
                        SELECT value, captured_at::text AS "capturedAt", mutated_at::text AS "mutatedAt", mutation_xid AS "mutationXid"
                        FROM operation_snapshots WHERE key=${key} FOR UPDATE`;
                    snapshots.set(
                        key,
                        stored
                            ? {
                                  ...stored,
                                  original: JSON.stringify(stored.value),
                                  applications: [],
                                  owners: [],
                              }
                            : null
                    );
                }
                const row = snapshots.get(key);
                if (!row) continue;
                const [visible] = await transaction<{ yes: boolean }[]>`
                    SELECT pg_visible_in_snapshot(${row.mutationXid}::xid8, ${visibility}::pg_snapshot)
                       AND ${row.capturedAt}::timestamptz < ${startedAt}::timestamptz
                       AND ${row.mutatedAt}::timestamptz < ${startedAt}::timestamptz
                       AND ${row.value.capturedAt}::timestamptz < ${startedAt}::timestamptz AS yes`;
                if (!visible?.yes) continue;
                const owners = recipes.flatMap((target) => {
                    const driver = target.driver;
                    if (driver.kind !== "docker") return [];
                    // A source's own recipe wins over physical-host aliases. Read-only
                    // aliases may inherit only one unambiguous configured owner.
                    const sourceOwnsName = recipes.some(
                        (candidate) =>
                            candidate.source === source &&
                            candidate.driver.kind === "docker" &&
                            candidate.driver.name === driver.name
                    );
                    return !sourceOwnsName || target.source === source ? [driver] : [];
                });
                row.applications.push(...allowed);
                row.owners.push(...owners);
            }
        }
    }
    // All hosts compare against the original locked mutation watermark. Write once
    // after collecting their matches so duplicate names across daemons cannot
    // overwrite one another based on host configuration order.
    for (const [key, row] of snapshots) {
        if (row)
            row.value = reconcileDockerObservations(
                row.value,
                row.applications,
                row.owners
            );
        if (row && JSON.stringify(row.value) !== row.original)
            await transaction`UPDATE operation_snapshots SET value=${JSON.stringify(row.value)}::text::jsonb WHERE key=${key}`;
    }
}
