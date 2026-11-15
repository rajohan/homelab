import { type MiraRunResolution, miraRunResolveSchema } from "@homelab/contracts/mira";
import * as v from "valibot";

import { auditMira, type MiraContext, MiraFailure } from "./context";

/**
 * Close human follow-up without changing execution results or authorizing more work.
 * @param context - Authenticated operator; model tools cannot resolve their own outcomes.
 * @param input - Exact terminal run and operator's bounded explanation.
 * @returns The durable resolution; identical retries return the original receipt.
 */
export async function resolveMiraRun(
    context: MiraContext,
    input: v.InferOutput<typeof miraRunResolveSchema>
) {
    const checked = v.parse(miraRunResolveSchema, input);
    if (context.run)
        throw new MiraFailure("FORBIDDEN", "Only the operator can close follow-up.");
    return context.client.begin(async (query) => {
        const [run] = await query<
            { state: string; resolution: MiraRunResolution | null; uncertain: boolean }[]
        >`SELECT state,followup_resolution AS resolution,EXISTS(SELECT 1 FROM mira_tool_receipts WHERE run_id=r.id AND state='unknown') AS uncertain FROM mira_runs r WHERE id=${checked.id} AND owner=${context.owner} FOR UPDATE`;
        if (!run) throw new MiraFailure("NOT_FOUND", "Run not found.");
        if (run.resolution) {
            if (
                run.resolution.outcome !== checked.outcome ||
                run.resolution.reason !== checked.reason
            )
                throw new MiraFailure(
                    "CONFLICT",
                    "Follow-up was already closed. Refresh to see the recorded decision."
                );
            return run.resolution;
        }
        if (
            ["queued", "running"].includes(run.state) ||
            (!run.uncertain &&
                !["failed", "interrupted", "needs_attention"].includes(run.state))
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "This run has no terminal follow-up to close."
            );
        const resolution: MiraRunResolution = {
            outcome: checked.outcome,
            reason: checked.reason,
            closedAt: new Date().toISOString(),
            closedBy: context.actor,
        };
        await query`UPDATE mira_runs SET followup_resolution=${JSON.stringify(resolution)}::text::jsonb WHERE id=${checked.id} AND owner=${context.owner}`;
        await auditMira(query, context, "run.followup_closed", checked.id);
        return resolution;
    });
}
