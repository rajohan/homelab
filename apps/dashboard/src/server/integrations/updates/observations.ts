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

/**
 * Detect bind-mounted application code that cannot be qualified by changing an image pin.
 * @param application - Safe Docker metadata, excluding environment and file contents.
 * @returns Whether a source overlay requires a separately qualified deployment.
 */
export function hasApplicationCodeMount(application: ManagedApplication): boolean {
    return application.mounts.some(
        (mount) =>
            mount.type === "bind" &&
            !mount.destination.startsWith("/opt/homelab/") &&
            (codeFile.test(mount.destination) || codeDirectory.test(mount.destination))
    );
}

/**
 * Refresh same-image container identities without carrying consent across a replacement.
 * @param report - Existing software publication or compatible release resolution.
 * @param applications - Current, explicitly bound project inventory.
 * @returns A report whose changed identities invalidate old confirmation revisions.
 */
export function reconcileDockerObservations(
    report: UpdateReport,
    applications: readonly ManagedApplication[]
): UpdateReport {
    return {
        ...report,
        items: report.items.map((item) => {
            if (item.kind !== "container") return item;
            const matches = applications.filter((app) => app.containerName === item.name);
            if (matches.length !== 1) return item;
            const app = matches[0]!;
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
 * @param inventory - Successful observations collected after the stored software report.
 * @param applications - Current explicit host/project/source bindings.
 * @param targets - Recipes used only to resolve existing physical-host aliases.
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
        if (!binding || !host.available) continue;
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
        // Receipt persistence takes the same raw-before-resolved order. Do not
        // advance publication timestamps or rewrite already queued confirmations.
        for (const prefix of ["updates:", "updates.resolved:"]) {
            for (const source of sources) {
                const key = `${prefix}${source}`;
                const [row] = await transaction<{ value: UpdateReport }[]>`
                    SELECT value FROM operation_snapshots WHERE key=${key} FOR UPDATE`;
                if (
                    !row ||
                    Date.parse(row.value.capturedAt) > Date.parse(inventory.capturedAt)
                )
                    continue;
                const updated = reconcileDockerObservations(row.value, allowed);
                if (JSON.stringify(updated) !== JSON.stringify(row.value))
                    await transaction`UPDATE operation_snapshots SET value=${JSON.stringify(updated)}::text::jsonb WHERE key=${key}`;
            }
        }
    }
}
