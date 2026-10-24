import type { MiraSchedule } from "@homelab/contracts/mira";

import { miraDependenciesAllowed, nextMiraOccurrence } from "./automations";
import { auditMira, MiraFailure, type MiraContext } from "./context";
import { enqueueTurn } from "./conversations";

const presets: {
    title: string;
    kind: "brief" | "summary" | "improvement" | "custom";
    prompt: string;
    schedule: MiraSchedule;
    budget: number;
}[] = [
    {
        title: "Morning brief",
        kind: "brief",
        schedule: { kind: "daily", time: "07:30" },
        budget: 180,
        prompt: "Prepare the morning brief from current tasks, blockers, recent recorded dashboard observations and available integration data. Respect intentional disable reasons. Identify stale or unavailable sources without inventing a healthy result. Save one concise brief report in the dashboard; do not send external messages.",
    },
    {
        title: "Evening summary",
        kind: "summary",
        schedule: { kind: "daily", time: "22:00" },
        budget: 180,
        prompt: "Summarize today's verified progress, task changes, unresolved blockers and meaningful operational findings. Do not repeat unchanged non-actionable observations or warnings attributable to intentional pauses. Save one summary report; do not send external messages.",
    },
    {
        title: "Dashboard improvement",
        kind: "improvement",
        schedule: { kind: "cron", expression: "30 9,18 * * *" },
        budget: 900,
        prompt: "Review Homelab tasks and existing PRs. Choose at most one worthwhile bounded dashboard improvement. Use the qualified isolated runner, pinned Bun, shared design and components, and Mira's verified GitHub identity. Run the required checks and open at most one small PR. Never merge, deploy, restart hosts, access secrets or incur new spending. If the required tools or authority are unavailable, record the blocker honestly. Save an improvement report.",
    },
    {
        title: "Heartbeat",
        kind: "custom",
        schedule: { kind: "interval", intervalSeconds: 1800 },
        budget: 120,
        prompt: "Review due tasks, blockers, failed runs and pending follow-ups. Respect disabled integrations and automations. Notify through a dashboard report only when a meaningful condition has changed or an operator decision is needed. If nothing actionable changed, return quietly without a report. Do not send external messages.",
    },
];

/**
 * Install recovered schedule definitions once, leaving activation to reviewed cutover.
 * @param context - Authenticated human owner of the restored automation collection.
 * @returns Number of definitions created; subsequent calls preserve edits and disable intent.
 */
export async function installMiraPresets(
    context: MiraContext
): Promise<{ created: number }> {
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:presets:${context.owner}`}, 0))`;
        const previous = await query<
            { id: string }[]
        >`SELECT id FROM mira_audit WHERE owner = ${context.owner} AND action = 'presets.installed' LIMIT 1`;
        if (previous[0]) return { created: 0 };
        for (const preset of presets) {
            const id = Bun.randomUUIDv7();
            await query`INSERT INTO mira_automations (id, owner, title, prompt, kind, delivery, schedule, budget_seconds, next_run_at) VALUES (${id}, ${context.owner}, ${preset.title}, ${preset.prompt}, ${preset.kind}, ${preset.kind === "custom" ? "changes" : "reports"}, ${JSON.stringify(preset.schedule)}::text::jsonb, ${preset.budget}, ${nextMiraOccurrence(preset.schedule, Date.now())})`;
            await query`INSERT INTO mira_switches (owner, key, enabled, reason) VALUES (${context.owner}, ${`automation:${id}`}, false, 'Awaiting migration review and integration qualification.')`;
        }
        await auditMira(query, context, "presets.installed", "mira");
        return { created: presets.length };
    });
}

/**
 * Run a saved automation once without changing its recurrence or deliberate pause.
 * @param context - Authenticated human owner.
 * @param id - Owned definition to run.
 * @param requestId - Stable browser-generated idempotency identifier.
 * @returns The queued run and its conversation; integration grants still apply.
 */
export async function runMiraAutomationNow(
    context: MiraContext,
    id: string,
    requestId: string
) {
    return context.client.begin(async (query) => {
        const [automation] = await query<
            { id: string; title: string; prompt: string; budget: number }[]
        >`SELECT id, title, prompt, budget_seconds AS budget FROM mira_automations WHERE id = ${id} AND owner = ${context.owner} AND deleted_at IS NULL FOR UPDATE`;
        if (!automation) throw new MiraFailure("NOT_FOUND", "Automation not found.");
        if (!(await miraDependenciesAllowed(query, context.owner, id)))
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "A required integration is disabled. Review its control before running this automation."
            );
        const [existing] = await query<
            { id: string; conversationId: string; automationId: string | null }[]
        >`SELECT id, conversation_id AS "conversationId", automation_id AS "automationId" FROM mira_runs WHERE request_key = ${`${context.owner}:${requestId}`}`;
        if (existing) {
            if (existing.automationId !== id)
                throw new MiraFailure(
                    "CONFLICT",
                    "This request belongs to another operation."
                );
            return { id: existing.id, conversationId: existing.conversationId };
        }
        const conversationId = Bun.randomUUIDv7();
        await query`INSERT INTO mira_conversations (id, owner, title) VALUES (${conversationId}, ${context.owner}, ${automation.title})`;
        const run = await enqueueTurn(
            query,
            context,
            { conversationId, requestId, text: automation.prompt, attachmentIds: [] },
            { automationId: id, budgetSeconds: automation.budget, manual: true }
        );
        return { ...run, conversationId };
    });
}

/**
 * Retire an automation and its queued work while keeping running work separately stoppable.
 * @param context - Authenticated human owner.
 * @param id - Owned definition.
 * @param version - Expected current version.
 * @returns Completion after the definition and queued invocations are retired.
 */
export async function deleteMiraAutomation(
    context: MiraContext,
    id: string,
    version: number
): Promise<void> {
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`}, 0))`;
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_automations SET deleted_at = now(), prompt = '', title = 'Deleted automation', version = version + 1, next_run_at = NULL WHERE id = ${id} AND owner = ${context.owner} AND version = ${version} AND deleted_at IS NULL RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "The automation changed. Refresh before deleting."
            );
        await query`UPDATE mira_switches SET enabled = false, reason = 'Automation deleted.', until = NULL, version = version + 1 WHERE owner = ${context.owner} AND key = ${`automation:${id}`}`;
        const queued = await query<
            { assistantMessageId: string }[]
        >`UPDATE mira_runs SET state = 'interrupted', message = 'Automation deleted before execution.', finished_at = now() WHERE automation_id = ${id} AND state = 'queued' RETURNING assistant_message_id AS "assistantMessageId"`;
        for (const run of queued)
            await query`UPDATE mira_messages SET state = 'interrupted' WHERE id = ${run.assistantMessageId}`;
        await auditMira(query, context, "automation.deleted", id);
    });
}
