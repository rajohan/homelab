import { miraHostCommandSchema } from "@homelab/contracts/miraOperations";
import { updateReportSchema } from "@homelab/contracts/updates";
import * as v from "valibot";

import { MiraFailure } from "../../data/context";
import type { MiraToolContext, MiraToolDefinition } from "../../executor/toolDefinition";
import {
    dashboardCapabilities,
    type MiraDashboardConfiguration,
    requestDashboard,
} from "./connection";

const sourcesSchema = v.array(
    v.object({
        id: v.string(),
        report: v.nullable(v.pick(updateReportSchema, ["capturedAt"])),
    })
);

export const inventoryPublication = {
    name: "publish_update_inventory",
    tool: "mira_dashboard_publish_inventory",
    arguments:
        "{source: registered update source with its own configured Homelab SSH target and systemd publisher}",
} as const;

/** Start the source's installed collector so its own identity publishes measured inventory.
 * @param input - Only the configured source ID; the model cannot supply inventory data.
 * @param context - Original owned run and durable host-command receipt.
 * @param signal - Run cancellation.
 * @param connection - Dashboard machine credential used only for grant and inventory reads.
 * @param hostCommand - Existing manual host action with connection and execution fences.
 * @param request - Trusted HTTPS transport for the dashboard reads.
 * @returns A verified capture timestamp, or the observed command outcome awaiting readback.
 */
export async function publishHostInventory(
    input: unknown,
    context: MiraToolContext,
    signal: AbortSignal,
    connection: MiraDashboardConfiguration,
    hostCommand: MiraToolDefinition,
    request: typeof fetch
) {
    const { source } = v.parse(
        v.strictObject({ source: miraHostCommandSchema.entries.target }),
        input
    );
    const readCapture = async () => {
        const result = await requestDashboard(
            connection,
            "updates.inventory",
            false,
            undefined,
            signal,
            request
        );
        const row = v.parse(sourcesSchema, result).find((entry) => entry.id === source);
        if (!row)
            throw new MiraFailure(
                "NOT_FOUND",
                "This host is not a registered update source."
            );
        return row.report?.capturedAt ?? null;
    };
    let before: string | null;
    try {
        const grants = await dashboardCapabilities(connection, signal, request);
        if (!grants.includes("updates:publish") || !grants.includes("updates:read"))
            throw new MiraFailure(
                "FORBIDDEN",
                "Publishing requires dashboard inventory read and publish permissions."
            );
        before = await readCapture();
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof MiraFailure) throw error;
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "The dashboard could not verify the inventory source and its permissions."
        );
    }

    const unit = `homelab-update-inventory@${source}.service`;
    const start = `systemctl start -- ${unit}`;
    const result = await hostCommand.action(
        {
            target: source,
            command: [
                `if [ "$(systemctl show --property=LoadState --value ${unit} 2>/dev/null)" != loaded ]; then echo 'This host has no configured systemd inventory publisher.' >&2; exit 1; fi`,
                `if [ "$(id -u)" = 0 ]; then exec ${start}; fi`,
                `exec sudo -n ${start}`,
            ].join("\n"),
            reason: "Publish measured software inventory using the registered host collector.",
            timeoutSeconds: 900,
        },
        signal,
        context
    );
    if (
        !result ||
        typeof result !== "object" ||
        !("exitCode" in result) ||
        result.exitCode !== 0
    )
        return result;

    try {
        const capturedAt = await readCapture();
        if (capturedAt && (!before || Date.parse(capturedAt) > Date.parse(before)))
            return { source, state: "published", capturedAt };
    } catch {
        signal.throwIfAborted();
    }
    return {
        source,
        state: "publisher_completed",
        message:
            "The host publisher finished. Check update_sources for a newer capturedAt before reporting a new inventory.",
    };
}
