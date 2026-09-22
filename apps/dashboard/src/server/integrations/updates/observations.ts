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

const codeFile = /\.(?:py|pyc|js|mjs|cjs|jsx|ts|tsx|so|node)$/i;
const codeDirectory =
    /^\/app(?:\/(?:src|lib|services|providers|api|utils|cw_platform)(?:\/.*)?)?\/?$/;
const overlayReason =
    "Local application code is mounted over this image. Review or remove the override before updating.";
type DockerOwner = Pick<
    Extract<UpdateTarget["driver"], { kind: "docker" }>,
    "name" | "project" | "service"
>;

/**
 * Detect bind-mounted application code that cannot be qualified by changing an image pin.
 * @param application - Safe Docker metadata, excluding environment and file contents.
 * @returns Whether a source overlay requires a separately qualified deployment.
 */
export function hasApplicationCodeMount(application: ManagedApplication): boolean {
    return application.mounts.some(
        (mount) =>
            mount.type === "bind" &&
            mount.destination !== "/opt/homelab/logout-worker.js" &&
            (codeFile.test(mount.destination) || codeDirectory.test(mount.destination))
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
            const { installationBlock: _block, ...previous } = item;
            if (app.image !== item.image || app.imageId !== item.installed)
                return {
                    ...previous,
                    candidateVerified: false,
                    available: null,
                    status: "unknown" as const,
                    installationBlock:
                        "The installed image changed. Refresh the host software inventory before updating.",
                };
            return {
                ...previous,
                id: `docker:${app.containerId}`,
                ...(hasApplicationCodeMount(app)
                    ? { installationBlock: overlayReason }
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
    for (const host of inventory.hosts) {
        const binding = applications.find((target) => target.id === host.id);
        const startedAt = host.observationStartedAt;
        if (
            !binding ||
            !host.available ||
            !startedAt ||
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
                const [row] = await transaction<{ value: UpdateReport }[]>`
                    SELECT value FROM operation_snapshots WHERE key=${key}
                    AND captured_at < ${startedAt}::timestamptz FOR UPDATE`;
                if (!row || Date.parse(row.value.capturedAt) >= Date.parse(startedAt))
                    continue;
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
                const updated = reconcileDockerObservations(row.value, allowed, owners);
                if (JSON.stringify(updated) !== JSON.stringify(row.value))
                    await transaction`UPDATE operation_snapshots SET value=${JSON.stringify(updated)}::text::jsonb WHERE key=${key}`;
            }
        }
    }
}
