import type {
    CalendarEvent,
    CalendarInput,
    CalendarRange,
} from "@homelab/contracts/miraCalendar";

import {
    auditMira,
    lockMiraProposals,
    type MiraContext,
    MiraFailure,
    miraTransaction,
} from "./context";

/** List overlapping appointments for the signed-in operator, including multi-day events.
 * @param context - Owner and database from the authenticated dashboard or Mira run.
 * @param range - Exclusive end, display time zone for all-day dates, and optional page cursor.
 * @returns Chronological events and an opaque continuation within the same range.
 */
export async function listCalendar(context: MiraContext, range: CalendarRange) {
    const sql = context.transaction ?? context.client;
    const rows = await sql<
        CalendarEvent[]
    >`SELECT id,title,notes,location,all_day AS "allDay",
        starts_at AS "startsAt",ends_at AS "endsAt",created_by AS "createdBy",version
        FROM mira_calendar_events WHERE owner=${context.owner}
        AND ((NOT all_day AND starts_at < ${range.end}::timestamptz AND ends_at > ${range.start}::timestamptz)
        OR (all_day AND starts_at < ((${range.end}::timestamptz AT TIME ZONE ${range.timeZone}) AT TIME ZONE 'UTC')
        AND ends_at > ((${range.start}::timestamptz AT TIME ZONE ${range.timeZone}) AT TIME ZONE 'UTC')))
        AND (${range.after?.id ?? null}::uuid IS NULL OR (starts_at,id) > (${range.after?.startsAt ?? null}::timestamptz,${range.after?.id ?? null}::uuid))
        ORDER BY starts_at,id LIMIT 101`;
    const items = rows.slice(0, 100).map((row) => ({
        ...row,
        startsAt: new Date(row.startsAt).toISOString(),
        endsAt: new Date(row.endsAt).toISOString(),
    }));
    const last = items.at(-1);
    return {
        items,
        next: rows.length > 100 && last ? { id: last.id, startsAt: last.startsAt } : null,
    };
}

/** Create an appointment or replace the reviewed revision and audit it atomically.
 * @param context - Verified owner, actor and optional tool receipt transaction.
 * @param input - Validated time range, event content, and existing identity for edits.
 * @param proposedByMira - Set by the approval handler for a human-confirmed Mira proposal.
 * @returns The saved identity and revision.
 */
export async function saveCalendarEvent(
    context: MiraContext,
    input: CalendarInput & { id?: string; version?: number },
    proposedByMira = false
) {
    return miraTransaction(context, async (sql) => {
        const id = input.id ?? Bun.randomUUIDv7();
        const [saved] = input.id
            ? await sql<{ id: string; version: number }[]>`UPDATE mira_calendar_events
          SET title=${input.title},notes=${input.notes},location=${input.location},starts_at=${input.startsAt},ends_at=${input.endsAt},all_day=${input.allDay},version=version+1
          WHERE id=${id} AND owner=${context.owner} AND version=${input.version ?? 0} RETURNING id,version`
            : await sql<
                  { id: string; version: number }[]
              >`INSERT INTO mira_calendar_events
          (id,owner,title,notes,location,starts_at,ends_at,all_day,created_by)
          VALUES (${id},${context.owner},${input.title},${input.notes},${input.location},${input.startsAt},${input.endsAt},${input.allDay},${context.run || proposedByMira ? "mira" : "operator"}) RETURNING id,version`;
        if (!saved)
            throw new MiraFailure(
                "CONFLICT",
                "This event changed or was deleted. Reopen it to see the current details."
            );
        await auditMira(
            sql,
            context,
            input.id ? "calendar.updated" : "calendar.created",
            id
        );
        return saved;
    });
}

/** Remove the exact owned revision and clear outstanding proposals for that event.
 * @param context - Verified owner, actor and optional receipt transaction.
 * @param input - The event and revision displayed to the operator.
 * @returns Completion after deletion and its audit record commit together.
 */
export async function deleteCalendarEvent(
    context: MiraContext,
    input: { id: string; version: number }
) {
    await miraTransaction(context, async (sql) => {
        await lockMiraProposals(sql, context.owner);
        const [removed] = await sql<
            { id: string }[]
        >`DELETE FROM mira_calendar_events WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} RETURNING id`;
        if (!removed)
            throw new MiraFailure(
                "CONFLICT",
                "This event changed or was deleted. Reopen it to see the current details."
            );
        await sql`UPDATE mira_tool_receipts t SET state='rejected',proposal=NULL,message='The calendar event was removed.',finished_at=now()
            FROM mira_runs r WHERE r.id=t.run_id AND r.owner=${context.owner} AND t.state='awaiting_approval'
            AND t.tool IN ('mira_calendar_update','mira_calendar_delete') AND t.proposal->>'id'=${input.id}`;
        await auditMira(sql, context, "calendar.deleted", input.id);
    });
}
