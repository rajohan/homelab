import type { MiraContext } from "./context";
import { MiraFailure } from "./context";

/** Read a bounded page of visible activity from one owned run.
 * @param context - Authenticated operator context.
 * @param input - Run, activity category and optional older-item cursor.
 * @returns Chronological rows, an older cursor and the full category count.
 */
export async function readChatActivity(
    context: MiraContext,
    input: { id: string; kind: "tools" | "notes"; before?: string | undefined }
) {
    const [run] = await context.client<
        { id: string }[]
    >`SELECT r.id FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id WHERE r.id=${input.id} AND r.owner=${context.owner} AND c.owner=${context.owner} AND c.deleted_at IS NULL`;
    if (!run) throw new MiraFailure("NOT_FOUND", "Run not found.");
    const table =
        input.kind === "tools"
            ? context.client`mira_tool_receipts`
            : context.client`mira_work_notes`;
    const fields =
        input.kind === "tools"
            ? context.client`tool,state,message`
            : context.client`'Work note'::text AS tool,'succeeded'::text AS state,content AS message`;
    const rows = await context.client<
        { id: string; tool: string; state: string; message: string | null }[]
    >`SELECT id,${fields} FROM ${table} WHERE run_id=${input.id} AND (${input.before ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM ${table} WHERE id=${input.before ?? null}::uuid AND run_id=${input.id})) ORDER BY created_at DESC,id DESC LIMIT 31`;
    const [count] = await context.client<
        { total: number }[]
    >`SELECT count(*)::int AS total FROM ${table} WHERE run_id=${input.id}`;
    const page = rows.slice(0, 30);
    return {
        rows: page.toReversed(),
        total: count?.total ?? 0,
        nextCursor: rows.length > 30 ? page.at(-1)!.id : null,
    };
}
