import {
    miraScheduleSchema,
    type MiraAutomation,
    type MiraSchedule,
    type MiraSwitch,
    type miraAutomationInputSchema,
    type miraEnableSchema,
} from "@homelab/contracts/mira";
import { miraSkillIds } from "@homelab/contracts/miraSkills";
import { nextScheduleOccurrence } from "@homelab/scheduling";
import type { SQL } from "bun";
import * as v from "valibot";

import { miraSkillsCompatibility } from "../skills/status";
import { auditMira, MiraFailure, type MiraContext, type MiraQuery } from "./context";

export const miraControlKeys = [
    ...miraSkillIds.map((id) => `skill:${id}` as const),
    "autonomy",
    "integration:agentmail",
    "integration:daytona",
    "integration:here-now",
    "integration:github",
    "integration:moltbook",
    "integration:moltbook-publish",
    "computer:windows",
    "computer:browser",
    "voice",
    "self-update",
] as const;

/**
 * Compute one future occurrence using Homelab's shared scheduling implementation.
 * @param input - Validated interval, daily, cron, one-time or event schedule.
 * @param after - Exclusive clock bound; missed recurring events are not replayed.
 * @param anchor - Original interval anchor used to avoid cadence drift.
 * @returns A future instant, or null for event schedules and completed one-time work.
 */
export function nextMiraOccurrence(
    input: MiraSchedule,
    after: number,
    anchor = after
): Date | null {
    const schedule = v.parse(miraScheduleSchema, input);
    if (schedule.kind === "event") return null;
    if (schedule.kind === "once") {
        const at = new Date(schedule.at);
        return at.getTime() > after ? at : null;
    }
    return nextScheduleOccurrence(schedule, after, anchor, "Europe/Oslo");
}

/**
 * Read independent feature and automation switches, including intentional disable reasons.
 * @param context - Authenticated product context.
 * @returns Persisted controls plus safe, disabled defaults for unconfigured integrations.
 */
export async function listMiraSwitches(context: MiraContext): Promise<MiraSwitch[]> {
    const rows = await context.client<
        MiraSwitch[]
    >`SELECT key, enabled, reason, until::text AS until, version FROM mira_switches s WHERE owner = ${context.owner} AND (s.key NOT LIKE 'automation:%' OR EXISTS (SELECT 1 FROM mira_automations a WHERE s.key='automation:'||a.id::text AND a.owner=s.owner AND a.deleted_at IS NULL)) ORDER BY key`;
    for (const key of miraControlKeys)
        if (!rows.some((row) => row.key === key))
            rows.push({
                key,
                enabled: key === "autonomy",
                reason: key === "autonomy" ? null : "Not enabled yet.",
                until: null,
                version: 1,
            });
    return rows;
}

/**
 * Read one page of editable automation definitions without credentials.
 * @param context - Authenticated product context.
 * @param before - Optional UUID cursor.
 * @returns Definitions and continuation metadata.
 */
export async function listMiraAutomations(context: MiraContext, before?: string) {
    const rows = await context.client<
        MiraAutomation[]
    >`SELECT id, title, prompt, kind, delivery, schedule, budget_seconds AS "budgetSeconds", version, next_run_at::text AS "nextRunAt" FROM mira_automations WHERE owner = ${context.owner} AND deleted_at IS NULL AND (${before ?? null}::uuid IS NULL OR id < ${before ?? null}::uuid) ORDER BY id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Create or revise an automation without re-enabling a deliberately disabled job.
 * @param context - Authenticated product context.
 * @param input - Validated definition and optional expected version.
 * @returns The automation ID; new definitions are disabled until enabled explicitly.
 */
export async function saveMiraAutomation(
    context: MiraContext,
    input: v.InferOutput<typeof miraAutomationInputSchema> & {
        id?: string;
        version?: number;
    }
) {
    let next: Date | null;
    try {
        next = nextMiraOccurrence(input.schedule, Date.now());
    } catch {
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose a valid schedule with a future occurrence."
        );
    }
    if (input.schedule.kind === "once" && !next)
        throw new MiraFailure("BAD_REQUEST", "Choose a future time for this automation.");
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const id = input.id ?? Bun.randomUUIDv7();
        if (input.id) {
            if (input.kind !== "improvement") {
                const [improvement] = await query<
                    { id: string }[]
                >`SELECT id FROM mira_improvements WHERE automation_id=${id} AND owner=${context.owner} AND state IN ('queued','checking','publishing','needs_attention') LIMIT 1`;
                if (improvement)
                    throw new MiraFailure(
                        "CONFLICT",
                        "Finish or review automatic code work before changing this automation's kind."
                    );
            }
            const [previous] = await query<{ schedule: MiraSchedule }[]>`
                SELECT schedule FROM mira_automations WHERE id=${id} AND owner=${context.owner} AND version=${input.version ?? 0} AND deleted_at IS NULL FOR UPDATE`;
            const oldEvent =
                previous?.schedule.kind === "event" ? previous.schedule.event : null;
            const newEvent =
                input.schedule.kind === "event" ? input.schedule.event : null;
            const changed = await query<
                { id: string }[]
            >`UPDATE mira_automations SET title = ${input.title}, prompt = ${input.prompt}, kind = ${input.kind}, delivery = ${input.delivery}, schedule = ${JSON.stringify(input.schedule)}::text::jsonb, budget_seconds = ${input.budgetSeconds}, next_run_at = ${next}, version = version + 1 WHERE id = ${id} AND owner = ${context.owner} AND version = ${input.version ?? 0} AND deleted_at IS NULL RETURNING id`;
            if (!changed[0])
                throw new MiraFailure(
                    "CONFLICT",
                    "The automation changed. Refresh before saving."
                );
            if (oldEvent !== newEvent) {
                const cancelled = await query<{ assistantMessageId: string }[]>`
                    UPDATE mira_runs r SET state='interrupted',message='Automation trigger changed before execution.',finished_at=now()
                    WHERE r.owner=${context.owner} AND r.automation_id=${id} AND NOT r.manual AND r.state='queued'
                    AND EXISTS (SELECT 1 FROM mira_event_deliveries d WHERE d.run_id=r.id)
                    RETURNING r.assistant_message_id AS "assistantMessageId"`;
                for (const run of cancelled)
                    await query`UPDATE mira_messages SET state='interrupted' WHERE id=${run.assistantMessageId}`;
                const key = `automation:${id}`;
                const [control] = await query<
                    { enabled: boolean; version: number; at: Date }[]
                >`UPDATE mira_switches SET version=version+1, changed_at=clock_timestamp() WHERE owner=${context.owner} AND key=${key} RETURNING enabled,version,changed_at AS at`;
                // Previous windows belonged to a different subscription. Audit receipts
                // remain intact; only receipt-time eligibility starts afresh.
                await query`DELETE FROM mira_control_windows WHERE owner=${context.owner} AND key=${key}`;
                if (control?.enabled)
                    await query`INSERT INTO mira_control_windows(owner,key,version,started_at) VALUES (${context.owner},${key},${control.version},${control.at})`;
                await query`UPDATE mira_event_deliveries SET state='skipped' WHERE automation_id=${id} AND state='pending'`;
            }
        } else {
            await query`INSERT INTO mira_automations (id, owner, title, prompt, kind, delivery, schedule, budget_seconds, next_run_at) VALUES (${id}, ${context.owner}, ${input.title}, ${input.prompt}, ${input.kind}, ${input.delivery}, ${JSON.stringify(input.schedule)}::text::jsonb, ${input.budgetSeconds}, ${next})`;
            await query`INSERT INTO mira_switches (owner, key, enabled, reason) VALUES (${context.owner}, ${`automation:${id}`}, false, 'Not enabled yet.')`;
        }
        await auditMira(
            query,
            context,
            input.id ? "automation.updated" : "automation.created",
            id
        );
        return { id };
    });
}

async function resetOccurrences(
    query: MiraQuery,
    owner: string,
    key: string,
    after: number
) {
    const automationId = key.startsWith("automation:") ? key.slice(11) : null;
    if (key !== "autonomy" && automationId === null) return;
    const rows = await query<
        { id: string; schedule: MiraSchedule }[]
    >`SELECT id, schedule FROM mira_automations WHERE owner = ${owner} AND deleted_at IS NULL AND (${automationId}::uuid IS NULL OR id = ${automationId}::uuid) FOR UPDATE`;
    for (const row of rows)
        await query`UPDATE mira_automations SET next_run_at = ${nextMiraOccurrence(row.schedule, after)} WHERE id = ${row.id}`;
}

/**
 * Change one control with a durable reason, optional resume time and no catch-up burst.
 * @param context - Verified human operator; tools cannot modify these grants.
 * @param input - Validated key, expected version and new state.
 * @param bindingHash - Verified service binding when explicitly enabling an integration.
 * @returns Completion after configuration and audit commit together.
 */
export async function setMiraEnabled(
    context: MiraContext,
    input: v.InferOutput<typeof miraEnableSchema>,
    bindingHash?: string
): Promise<void> {
    if (input.until && new Date(input.until).getTime() <= Date.now())
        throw new MiraFailure("BAD_REQUEST", "Choose a future resume time.");
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`}, 0))`;
        if (input.key.startsWith("automation:")) {
            const id = v.safeParse(v.pipe(v.string(), v.uuid()), input.key.slice(11));
            if (!id.success) throw new MiraFailure("BAD_REQUEST", "Unknown control.");
            const rows = await query<
                { id: string }[]
            >`SELECT id FROM mira_automations WHERE owner = ${context.owner} AND id = ${id.output} AND deleted_at IS NULL`;
            if (!rows[0]) throw new MiraFailure("NOT_FOUND", "Automation not found.");
        } else if (!miraControlKeys.some((key) => key === input.key))
            throw new MiraFailure("BAD_REQUEST", "Unknown control.");
        if (
            input.enabled &&
            input.key.startsWith("skill:") &&
            (await miraSkillsCompatibility(query)) !== "available"
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Mira must be connected with the same skill catalog before enabling guidance."
            );
        const inserted = await query<
            { enabled: boolean }[]
        >`INSERT INTO mira_switches (owner, key, enabled, reason) VALUES (${context.owner}, ${input.key}, ${input.key === "autonomy"}, ${input.key === "autonomy" ? null : "Not enabled yet."}) ON CONFLICT DO NOTHING RETURNING enabled`;
        if (inserted[0]?.enabled)
            await query`INSERT INTO mira_control_windows (owner, key, version, started_at) VALUES (${context.owner}, ${input.key}, 1, '1970-01-01'::timestamptz)`;
        const rows = await query<
            { key: string; version: number; at: Date }[]
        >`UPDATE mira_switches SET enabled = ${input.enabled}, reason = ${input.reason}, until = ${input.until ? new Date(input.until) : null}, version = version + 1, changed_at = clock_timestamp(), binding_activated_at = CASE WHEN ${input.key} IN ('integration:agentmail','integration:moltbook','integration:moltbook-publish','integration:here-now','integration:daytona','integration:github') AND ${input.enabled} AND binding_hash IS DISTINCT FROM ${bindingHash ?? null} THEN clock_timestamp() ELSE binding_activated_at END, binding_hash = CASE WHEN ${input.key} IN ('integration:agentmail','integration:moltbook','integration:moltbook-publish','integration:here-now','integration:daytona','integration:github') AND ${input.enabled} THEN ${bindingHash ?? null} ELSE binding_hash END WHERE owner = ${context.owner} AND key = ${input.key} AND version = ${input.version} RETURNING key, version, changed_at AS at`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "This control changed. Refresh before continuing."
            );
        await query`UPDATE mira_control_windows SET ended_at = ${rows[0].at} WHERE owner = ${context.owner} AND key = ${input.key} AND ended_at IS NULL`;
        if (input.enabled)
            await query`INSERT INTO mira_control_windows (owner, key, version, started_at) VALUES (${context.owner}, ${input.key}, ${rows[0].version}, ${rows[0].at})`;
        await resetOccurrences(query, context.owner, input.key, Date.now());
        if (
            !input.enabled &&
            (input.key === "autonomy" ||
                input.key.startsWith("automation:") ||
                input.key.startsWith("integration:"))
        ) {
            const automationId = input.key.startsWith("automation:")
                ? input.key.slice(11)
                : null;
            const event = input.key === "integration:agentmail" ? "agentmail" : null;
            if (input.key === "autonomy" || automationId || event) {
                const cancelled = await query<
                    { assistantMessageId: string }[]
                >`UPDATE mira_runs r SET state = 'interrupted', message = 'Automation paused before execution.', finished_at = now() WHERE r.owner = ${context.owner} AND NOT r.manual AND r.state = 'queued' AND r.automation_id IS NOT NULL AND (${automationId}::uuid IS NULL OR r.automation_id = ${automationId}::uuid) AND (${event}::text IS NULL OR EXISTS (SELECT 1 FROM mira_automations a WHERE a.id = r.automation_id AND a.schedule->>'event' = ${event})) RETURNING r.assistant_message_id AS "assistantMessageId"`;
                for (const run of cancelled)
                    await query`UPDATE mira_messages SET state = 'interrupted' WHERE id = ${run.assistantMessageId}`;
                await query`UPDATE mira_event_deliveries d SET state = 'skipped' FROM mira_automations a WHERE a.id = d.automation_id AND a.owner = ${context.owner} AND d.state = 'pending' AND (${automationId}::uuid IS NULL OR a.id = ${automationId}::uuid) AND (${event}::text IS NULL OR a.schedule->>'event' = ${event})`;
            }
        }
        await auditMira(
            query,
            context,
            input.enabled ? "control.enabled" : "control.disabled",
            input.key
        );
    });
}

/**
 * Resume elapsed deliberate pauses and move recurring schedules into the future.
 * @param query - Scheduler transaction, serialized with control mutations.
 * @param now - Scheduler clock.
 * @param owner - Optional account filter for a verified event transaction.
 * @returns Completion without replaying missed invocations.
 */
export async function resumeMiraControls(
    query: MiraQuery,
    now: Date,
    owner?: string
): Promise<void> {
    const owners = await query<
        { owner: string }[]
    >`SELECT DISTINCT owner FROM mira_switches WHERE NOT enabled AND until <= ${now} AND (${owner ?? null}::text IS NULL OR owner = ${owner ?? null}) ORDER BY owner`;
    for (const account of owners) {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${account.owner}`}, 0))`;
        const rows = await query<
            { owner: string; key: string }[]
        >`SELECT owner, key FROM mira_switches WHERE owner = ${account.owner} AND NOT enabled AND until <= ${now} FOR UPDATE`;
        for (const row of rows) {
            if (
                row.key.startsWith("skill:") &&
                (await miraSkillsCompatibility(query)) !== "available"
            )
                continue;
            if (
                row.key === "integration:agentmail" ||
                row.key === "integration:moltbook" ||
                row.key === "integration:moltbook-publish" ||
                row.key === "integration:here-now" ||
                row.key === "integration:github" ||
                row.key === "integration:daytona"
            ) {
                const integration = row.key.slice(12);
                const [binding] = await query<{ current: boolean }[]>`
                    SELECT EXISTS (SELECT 1 FROM mira_switches c
                        JOIN mira_integration_receivers receiver ON receiver.key=${integration} AND receiver.binding_hash=c.binding_hash
                        JOIN mira_runtime_status runtime ON runtime.id=1
                        WHERE c.owner=${row.owner} AND c.key=${row.key}
                        AND receiver.heartbeat_at > now()-interval '45 seconds'
                        AND runtime.heartbeat_at > now()-interval '45 seconds'
                        AND runtime.integrations @> jsonb_build_array(jsonb_build_object('owner',c.owner,'key',${integration}::text,'bindingHash',c.binding_hash) || CASE WHEN ${integration}::text IN ('daytona','github') THEN '{"sendConfigured":true}'::jsonb ELSE '{}'::jsonb END)) AS current`;
                if (!binding?.current) continue;
            }
            const [resumed] = await query<
                { version: number; at: Date }[]
            >`UPDATE mira_switches SET enabled = true, reason = NULL, changed_at = until, until = NULL, version = version + 1 WHERE owner = ${row.owner} AND key = ${row.key} RETURNING version, changed_at AS at`;
            await query`INSERT INTO mira_control_windows (owner, key, version, started_at) VALUES (${row.owner}, ${row.key}, ${resumed!.version}, ${resumed!.at})`;
            await resetOccurrences(query, row.owner, row.key, now.getTime());
            await auditMira(
                query,
                { owner: row.owner, actor: "mira:scheduler" },
                "control.resumed",
                row.key
            );
        }
    }
}

/**
 * Check current automation grants at dispatch; stopping active work is a separate action.
 * @param query - Current database connection or transaction.
 * @param owner - Verified run owner.
 * @param automationId - Scheduler-owned automation, or null for user-started chat.
 * @returns Whether this invocation may still run.
 */
export async function miraRunAllowed(
    query: MiraQuery,
    owner: string,
    automationId: string | null
): Promise<boolean> {
    if (!automationId) return true;
    const rows = await query<
        { allowed: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM mira_automations a JOIN mira_switches s ON s.owner = a.owner AND s.key = 'automation:' || a.id::text WHERE a.id = ${automationId} AND a.owner = ${owner} AND a.deleted_at IS NULL AND s.enabled AND (a.schedule->>'event' IS DISTINCT FROM 'agentmail' OR EXISTS (SELECT 1 FROM mira_switches i WHERE i.owner = a.owner AND i.key = 'integration:agentmail' AND i.enabled))) AND NOT EXISTS (SELECT 1 FROM mira_switches WHERE owner = ${owner} AND key = 'autonomy' AND NOT enabled) AS allowed`;
    return rows[0]?.allowed === true;
}

/**
 * Recheck required integrations even for an explicitly requested one-off automation run.
 * @param query - Current database connection or transaction.
 * @param owner - Verified run owner.
 * @param automationId - Internal automation reference, or null for ordinary chat.
 * @returns Whether required integrations remain enabled; recurrence pause is independent.
 */
export async function miraDependenciesAllowed(
    query: MiraQuery,
    owner: string,
    automationId: string | null
): Promise<boolean> {
    if (!automationId) return true;
    const [row] = await query<
        { allowed: boolean }[]
    >`SELECT (schedule->>'event' IS DISTINCT FROM 'agentmail' OR EXISTS (SELECT 1 FROM mira_switches WHERE owner = ${owner} AND key = 'integration:agentmail' AND enabled)) AS allowed FROM mira_automations WHERE id = ${automationId} AND owner = ${owner} AND deleted_at IS NULL`;
    return row?.allowed === true;
}

/**
 * Apply elapsed pause deadlines independently of inference-provider availability.
 * @param client - Product database pool; this operation never queues or starts model work.
 * @param now - Reconciliation clock, injectable for deterministic recovery tests.
 * @returns Completion after expired controls and their next occurrences are committed.
 */
export async function reconcileMiraControls(
    client: SQL,
    now = new Date()
): Promise<void> {
    await client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:scheduler', 0))`;
        await resumeMiraControls(query, now);
    });
}

/**
 * Read a bounded page of current operator controls and intentional pause reasons.
 * @param context - Verified account; no credentials or other owners' controls are exposed.
 * @param after - Exclusive key cursor from the preceding page.
 * @returns Saved or default controls, automation titles and continuation metadata.
 */
export async function readMiraControlPage(context: MiraContext, after?: string) {
    const defaults = miraControlKeys.map((key) => ({
        key,
        enabled: key === "autonomy",
        reason: key === "autonomy" ? null : "Not enabled yet.",
    }));
    const rows = await context.client<
        (MiraSwitch & { automationTitle: string | null })[]
    >`WITH controls AS (SELECT key,enabled,reason,until,version FROM mira_switches WHERE owner=${context.owner} UNION ALL SELECT d.key,d.enabled,d.reason,NULL::timestamptz,1 FROM jsonb_to_recordset(${JSON.stringify(defaults)}::text::jsonb) AS d(key text,enabled boolean,reason text) WHERE NOT EXISTS(SELECT 1 FROM mira_switches s WHERE s.owner=${context.owner} AND s.key=d.key)) SELECT c.key,c.enabled,c.reason,c.until::text AS until,c.version,a.title AS "automationTitle" FROM controls c LEFT JOIN mira_automations a ON c.key='automation:'||a.id::text AND a.owner=${context.owner} WHERE (c.key NOT LIKE 'automation:%' OR (a.id IS NOT NULL AND a.deleted_at IS NULL)) AND (${after ?? null}::text IS NULL OR c.key>${after ?? null}) ORDER BY c.key LIMIT 50`;
    return { rows, nextCursor: rows.length === 50 ? rows.at(-1)!.key : null };
}
