import {
    calendarEndTimestamp,
    type CalendarEvent,
    type CalendarInput,
    type CalendarRange,
} from "@homelab/contracts/miraCalendar";

import {
    auditMira,
    lockMiraProposals,
    type MiraContext,
    MiraFailure,
    miraTransaction,
} from "./context";
import { cancelRun } from "./conversations";

const iso = (value: string | null | undefined) =>
    value ? new Date(value).toISOString() : null;
function wakeDeadline(input: CalendarInput) {
    const miraAt = input.miraReminderAt ? Date.parse(input.miraReminderAt) : null;
    const operatorAt = input.operatorReminderAt
        ? Date.parse(input.operatorReminderAt)
        : null;
    if (miraAt === null && operatorAt === null) return null;
    const end = calendarEndTimestamp(input);
    if (input.allDay && input.timeZone && miraAt !== null && miraAt >= end)
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose a Mira reminder before the all-day event ends in its time zone."
        );
    if ((operatorAt !== null && operatorAt > end) || (miraAt !== null && miraAt > end))
        throw new MiraFailure(
            "BAD_REQUEST",
            "Move or turn off reminders that fall after the end of this event."
        );
    if (miraAt === null) return null;
    // A timed reminder scheduled exactly at the end still gets one scheduler minute to start.
    if (miraAt === end) return new Date(end + 60_000);
    return new Date(end);
}
function serializeEvent(row: CalendarEvent): CalendarEvent {
    return {
        ...row,
        startsAt: new Date(row.startsAt).toISOString(),
        endsAt: new Date(row.endsAt).toISOString(),
        operatorReminderAt: iso(row.operatorReminderAt),
        miraReminderAt: iso(row.miraReminderAt),
    };
}

/** Read the appointment behind a personal notification in any calendar month.
 * @param context - Authenticated reader's owner and database.
 * @param id - Requested event identifier.
 * @returns Current owned event, or null if it is unavailable.
 */
export async function getCalendarEvent(context: MiraContext, id: string) {
    const query = context.transaction ?? context.client;
    const [row] = await query<
        CalendarEvent[]
    >`SELECT id,title,notes,location,all_day AS "allDay",
        starts_at AS "startsAt",ends_at AS "endsAt",time_zone AS "timeZone",created_by AS "createdBy",version,
        operator_reminder_at AS "operatorReminderAt",mira_reminder_at AS "miraReminderAt"
        FROM mira_calendar_events WHERE id=${id} AND owner=${context.owner}`;
    return row ? serializeEvent(row) : null;
}

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
        starts_at AS "startsAt",ends_at AS "endsAt",time_zone AS "timeZone",created_by AS "createdBy",version,
        operator_reminder_at AS "operatorReminderAt",mira_reminder_at AS "miraReminderAt"
        FROM mira_calendar_events WHERE owner=${context.owner}
        AND ((NOT all_day AND starts_at < ${range.end}::timestamptz AND ends_at > ${range.start}::timestamptz)
        OR (all_day AND starts_at < ((${range.end}::timestamptz AT TIME ZONE ${range.timeZone}) AT TIME ZONE 'UTC')
        AND ends_at > ((${range.start}::timestamptz AT TIME ZONE ${range.timeZone}) AT TIME ZONE 'UTC')))
        AND (${range.after?.id ?? null}::uuid IS NULL OR (starts_at,id) > (${range.after?.startsAt ?? null}::timestamptz,${range.after?.id ?? null}::uuid))
        ORDER BY starts_at,id LIMIT 101`;
    const items = rows.slice(0, 100).map((row) => serializeEvent(row));
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
        let version = 1;
        if (input.id) {
            const [old] = await sql<
                {
                    operatorAt: string | null;
                    miraAt: string | null;
                    runId: string | null;
                    timeZone: string | null;
                }[]
            >`
                SELECT operator_reminder_at AS "operatorAt",mira_reminder_at AS "miraAt",mira_reminder_run_id AS "runId",time_zone AS "timeZone"
                FROM mira_calendar_events WHERE id=${id} AND owner=${context.owner} AND version=${input.version ?? 0} FOR UPDATE`;
            if (!old)
                throw new MiraFailure(
                    "CONFLICT",
                    "This event changed or was deleted. Reopen it to see the current details."
                );
            const operatorAt = iso(
                input.operatorReminderAt === undefined
                    ? old.operatorAt
                    : input.operatorReminderAt
            );
            const miraAt = iso(
                input.miraReminderAt === undefined ? old.miraAt : input.miraReminderAt
            );
            const timeZone = input.timeZone ?? old.timeZone ?? undefined;
            const deadline = wakeDeadline({
                ...input,
                timeZone,
                operatorReminderAt: operatorAt,
                miraReminderAt: miraAt,
            });
            if (old.runId && iso(old.miraAt) !== miraAt)
                await cancelRun({ ...context, transaction: sql }, old.runId);
            await sql`UPDATE mira_calendar_events SET title=${input.title},notes=${input.notes},location=${input.location},
                starts_at=${input.startsAt},ends_at=${input.endsAt},all_day=${input.allDay},time_zone=${timeZone ?? null},version=version+1,
                operator_reminded_at=CASE WHEN operator_reminder_at=${operatorAt}::timestamptz THEN operator_reminded_at END,
                mira_reminder_run_id=CASE WHEN mira_reminder_at=${miraAt}::timestamptz THEN mira_reminder_run_id END,
                operator_reminder_at=${operatorAt},mira_reminder_at=${miraAt},mira_reminder_until=${deadline}
                WHERE id=${id} AND owner=${context.owner}`;
            version = (input.version ?? 0) + 1;
        } else {
            await sql`INSERT INTO mira_calendar_events
                (id,owner,title,notes,location,starts_at,ends_at,all_day,created_by,operator_reminder_at,mira_reminder_at,mira_reminder_until,time_zone)
                VALUES (${id},${context.owner},${input.title},${input.notes},${input.location},${input.startsAt},${input.endsAt},
                ${input.allDay},${context.run || proposedByMira ? "mira" : "operator"},${iso(input.operatorReminderAt)},${iso(input.miraReminderAt)},${wakeDeadline(input)},${input.timeZone ?? null})`;
        }
        await auditMira(
            sql,
            context,
            input.id ? "calendar.updated" : "calendar.created",
            id
        );
        return { id, version };
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
            { runId: string | null }[]
        >`DELETE FROM mira_calendar_events WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} RETURNING mira_reminder_run_id AS "runId"`;
        if (!removed)
            throw new MiraFailure(
                "CONFLICT",
                "This event changed or was deleted. Reopen it to see the current details."
            );
        if (removed.runId)
            await cancelRun({ ...context, transaction: sql }, removed.runId);
        await sql`DELETE FROM dashboard_notifications WHERE source='calendar' AND recipient=${`human:${context.owner}`} AND source_key LIKE ${`${input.id}:%`}`;
        await sql`UPDATE mira_tool_receipts t SET state='rejected',proposal=NULL,message='The calendar event was removed.',finished_at=now()
            FROM mira_runs r WHERE r.id=t.run_id AND r.owner=${context.owner} AND t.state='awaiting_approval'
            AND t.tool IN ('mira_calendar_update','mira_calendar_delete') AND t.proposal->>'id'=${input.id}`;
        await auditMira(sql, context, "calendar.deleted", input.id);
    });
}
