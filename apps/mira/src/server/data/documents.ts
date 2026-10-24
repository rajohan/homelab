import type {
    MiraMemory,
    MiraReport,
    miraPageSchema,
    miraReportInputSchema,
    miraReportFilterSchema,
} from "@homelab/contracts/mira";
import type * as v from "valibot";

import { auditMira, MiraFailure, requireTask, type MiraContext } from "./context";

/**
 * Read bounded immutable report snapshots for the signed-in owner.
 * @param context - Authenticated product context.
 * @param input - Search, archive state and pagination cursor.
 * @returns Matching reports and a continuation cursor.
 */
export async function listReports(
    context: MiraContext,
    input: v.InferOutput<typeof miraReportFilterSchema>
) {
    const rows = await context.client<
        MiraReport[]
    >`SELECT p.id, p.title, p.kind, p.markdown, p.task_id AS "taskId", p.run_id AS "runId", p.version, p.archived_at::text AS "archivedAt", p.created_at::text AS "createdAt", r.automation_id AS "automationId", c.id AS "conversationId", r.state AS outcome, CASE WHEN r.automation_id IS NOT NULL THEN 'automation' WHEN r.id IS NOT NULL THEN 'chat' ELSE 'manual' END AS source FROM mira_reports p LEFT JOIN mira_runs r ON r.id = p.run_id AND r.owner = p.owner LEFT JOIN mira_conversations c ON c.id = r.conversation_id AND c.owner = p.owner AND c.deleted_at IS NULL WHERE p.owner = ${context.owner} AND p.deleted_at IS NULL AND (p.archived_at IS NOT NULL) = ${input.archived} AND (${input.before ?? null}::uuid IS NULL OR p.id < ${input.before ?? null}::uuid) AND strpos(lower(p.title || ' ' || p.markdown || ' ' || p.kind), lower(${input.search})) > 0 AND (${input.kind ?? null}::text IS NULL OR p.kind = ${input.kind ?? null}) AND (${input.outcome ?? null}::text IS NULL OR r.state = ${input.outcome ?? null}) AND (${input.source ?? null}::text IS NULL OR (CASE WHEN r.automation_id IS NOT NULL THEN 'automation' WHEN r.id IS NOT NULL THEN 'chat' ELSE 'manual' END) = ${input.source ?? null}) AND (${input.from ?? null}::timestamptz IS NULL OR p.created_at >= ${input.from ?? null}::timestamptz) AND (${input.until ?? null}::timestamptz IS NULL OR p.created_at < ${input.until ?? null}::timestamptz) ORDER BY p.id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Resolve a stable report link, retaining an explicit tombstone after content deletion.
 * @param context - Authenticated product context.
 * @param id - Owned report identity.
 * @returns Report content, current linked execution state and deletion status.
 */
export async function readReport(context: MiraContext, id: string) {
    const [report] = await context.client<
        (MiraReport & { deleted: boolean })[]
    >`SELECT p.id, p.title, p.kind, p.markdown, p.task_id AS "taskId", p.run_id AS "runId", p.version, p.archived_at::text AS "archivedAt", p.created_at::text AS "createdAt", p.deleted_at IS NOT NULL AS deleted, r.automation_id AS "automationId", c.id AS "conversationId", r.state AS outcome, CASE WHEN r.automation_id IS NOT NULL THEN 'automation' WHEN r.id IS NOT NULL THEN 'chat' ELSE 'manual' END AS source FROM mira_reports p LEFT JOIN mira_runs r ON r.id = p.run_id AND r.owner = p.owner LEFT JOIN mira_conversations c ON c.id = r.conversation_id AND c.owner = p.owner AND c.deleted_at IS NULL WHERE p.id = ${id} AND p.owner = ${context.owner}`;
    if (!report) throw new MiraFailure("NOT_FOUND", "Report not found.");
    return report;
}

/**
 * Create a permanent report snapshot linked to an owned task and optional active run.
 * @param context - Verified human or execution-scoped actor.
 * @param input - Validated report content.
 * @param runId - Internal run reference, never taken from the browser or model.
 * @returns The report identity for stable dashboard links.
 */
export async function createReport(
    context: MiraContext,
    input: v.InferOutput<typeof miraReportInputSchema>,
    runId: string | null = null
) {
    return context.client.begin(async (query) => {
        await requireTask(query, context.owner, input.taskId);
        const id = Bun.randomUUIDv7();
        await query`INSERT INTO mira_reports (id, owner, title, kind, markdown, task_id, run_id) VALUES (${id}, ${context.owner}, ${input.title}, ${input.kind}, ${input.markdown}, ${input.taskId}, ${runId})`;
        await auditMira(query, context, "report.created", id);
        return { id };
    });
}

/**
 * Archive, restore or remove report content without destroying execution evidence.
 * @param context - Authenticated product context.
 * @param input - Record, expected version and requested lifecycle transition.
 * @returns Completion after the transition and audit commit.
 */
export async function changeReport(
    context: MiraContext,
    input: { id: string; version: number; action: "archive" | "restore" | "delete" }
): Promise<void> {
    await context.client.begin(async (query) => {
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_reports SET archived_at = ${input.action === "archive" ? new Date() : null}, deleted_at = ${input.action === "delete" ? new Date() : null}, markdown = CASE WHEN ${input.action === "delete"} THEN '' ELSE markdown END, title = CASE WHEN ${input.action === "delete"} THEN 'Deleted report' ELSE title END, version = version + 1 WHERE id = ${input.id} AND owner = ${context.owner} AND version = ${input.version} AND deleted_at IS NULL RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "The report changed. Refresh before continuing."
            );
        await auditMira(query, context, `report.${input.action}`, input.id);
    });
}

/**
 * Read explicit memory separately from conversation history.
 * @param context - Authenticated product context.
 * @param input - Search and cursor within the owner's memory.
 * @returns Editable memory records and pagination metadata.
 */
export async function listMemory(
    context: MiraContext,
    input: v.InferOutput<typeof miraPageSchema>
) {
    const rows = await context.client<
        MiraMemory[]
    >`SELECT id, title, content, version, updated_at::text AS "updatedAt" FROM mira_memory WHERE owner = ${context.owner} AND (${input.before ?? null}::uuid IS NULL OR id < ${input.before ?? null}::uuid) AND strpos(lower(title || ' ' || content), lower(${input.search})) > 0 ORDER BY id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Save operator-visible memory under version control.
 * @param context - Verified human or authorized execution actor.
 * @param input - Validated memory content and optional expected version.
 * @returns The memory identity.
 */
export async function saveMemory(
    context: MiraContext,
    input: { id?: string; version?: number; title: string; content: string }
) {
    return context.client.begin(async (query) => {
        const id = input.id ?? Bun.randomUUIDv7();
        if (input.id) {
            const rows = await query<
                { id: string }[]
            >`UPDATE mira_memory SET title = ${input.title}, content = ${input.content}, version = version + 1, updated_at = now() WHERE id = ${id} AND owner = ${context.owner} AND version = ${input.version ?? 0} RETURNING id`;
            if (!rows[0])
                throw new MiraFailure(
                    "CONFLICT",
                    "The memory changed. Refresh before saving."
                );
        } else
            await query`INSERT INTO mira_memory (id, owner, title, content) VALUES (${id}, ${context.owner}, ${input.title}, ${input.content})`;
        await auditMira(
            query,
            context,
            input.id ? "memory.updated" : "memory.created",
            id
        );
        return { id };
    });
}

/**
 * Delete explicit memory without retaining its content in audit records.
 * @param context - Authenticated product context.
 * @param id - Owned memory record.
 * @param version - Expected current version.
 * @returns Completion after deletion.
 */
export async function deleteMemory(
    context: MiraContext,
    id: string,
    version: number
): Promise<void> {
    await context.client.begin(async (query) => {
        const rows = await query<
            { id: string }[]
        >`DELETE FROM mira_memory WHERE id = ${id} AND owner = ${context.owner} AND version = ${version} RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "The memory changed. Refresh before deleting."
            );
        await auditMira(query, context, "memory.deleted", id);
    });
}
