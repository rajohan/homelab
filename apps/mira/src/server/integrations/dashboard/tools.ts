import {
    type Capability,
    capabilitySchema,
    idSchema,
} from "@homelab/contracts/operations";
import * as v from "valibot";

import { miraManualRunAllowed } from "../../data/approvalPolicy";
import { MiraFailure } from "../../data/context";
import type { MiraClaim } from "../../data/queue";
import { isMiraReportRun, miraReportRunAllowed } from "../../data/reportAccess";
import type { MiraToolContext, MiraToolDefinition } from "../../executor/toolDefinition";
import { dashboardActions, dashboardReads } from "./catalog";
import { type MiraDashboardConfiguration, requestDashboard } from "./connection";

const fields = v.optional(v.record(v.string(), v.unknown()));
const readNames = Object.keys(dashboardReads) as (keyof typeof dashboardReads)[];
const actionNames = Object.keys(dashboardActions) as (keyof typeof dashboardActions)[];
const pathSchema = v.pipe(v.array(v.pipe(v.string(), v.maxLength(256))), v.maxLength(12));
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
});
const argumentsField = { type: "object", additionalProperties: true };
const operatorOnly = [
    {
        action: "Confirm a system service restart or host reboot",
        href: "/updates#maintenance",
    },
    {
        action: "Confirm or cancel a Homelab release deployment",
        href: "/updates#releases",
    },
    { action: "Change automatic-update policy", href: "/updates#software" },
    { action: "Manage machine accounts, tokens or account security", href: "/settings" },
] as const;

function portion(result: unknown, path: readonly string[], offset: number) {
    let selected = result;
    for (const field of path) {
        if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, field))
            throw new MiraFailure(
                "NOT_FOUND",
                "This field or array index is absent from the current dashboard result."
            );
        selected = (selected as Record<string, unknown>)[field];
    }
    if (Array.isArray(selected)) {
        const list: unknown[] = selected;
        const items: unknown[] = [];
        let length = 0;
        for (const item of list.slice(offset, offset + 50)) {
            const size = JSON.stringify(item).length;
            if (size > 12_000) {
                items.push({ inspectPath: [...path, String(offset + items.length)] });
            } else {
                if (length + size > 16_000) break;
                items.push(item);
                length += size;
            }
        }
        return {
            items,
            total: list.length,
            nextOffset:
                offset + items.length < list.length ? offset + items.length : null,
        };
    }
    if (typeof selected === "string" && (selected.length > 16_000 || offset > 0))
        return {
            text: selected.slice(offset, offset + 16_000),
            nextOffset: offset + 16_000 < selected.length ? offset + 16_000 : null,
        };
    if (
        selected &&
        typeof selected === "object" &&
        JSON.stringify(selected).length > 16_000
    )
        return {
            fields: Object.keys(selected),
            message: "Select a field with path to inspect this result.",
        };
    return { data: selected };
}

async function checkRun(
    context: MiraToolContext,
    signal: AbortSignal,
    report?: MiraClaim
) {
    signal.throwIfAborted();
    const allowed = report
        ? context.owner === report.owner &&
          context.actor === `mira:${report.id}` &&
          context.run?.leaseToken === report.leaseToken &&
          (await miraReportRunAllowed(context.client, report))
        : await miraManualRunAllowed(context.client, context);
    if (!allowed)
        throw new MiraFailure(
            "FORBIDDEN",
            "This run no longer has access to the dashboard."
        );
    signal.throwIfAborted();
}

/** Expose the operational dashboard API to its configured owner's manual work and read-only reports.
 * @param run - Durable claim selected by the executor, independent of tool arguments.
 * @param connection - Explicit per-owner machine credential with live dashboard grants.
 * @param request - HTTP transport, replaceable for isolated verification.
 * @returns Discovery, bounded reads and explicitly named operational requests.
 */
export function createMiraDashboardTools(
    run: MiraClaim,
    connection?: MiraDashboardConfiguration,
    request: typeof fetch = fetch
): MiraToolDefinition[] {
    const report = isMiraReportRun(run) ? run : undefined;
    if (
        !report &&
        (!run.manual || run.automationId || run.taskAssessment || run.calendarEventId)
    )
        return [];
    const bound = connection?.owner === run.owner ? connection : undefined;
    const access: MiraToolDefinition = {
        name: "mira_dashboard_access",
        description:
            "Discover this chat's operational dashboard views and actions with their current permissions and argument formats. Task, calendar and other dedicated Mira tools are listed separately.",
        inputSchema: object({}),
        readOnly: true,
        automatic: !!report,
        action: async (input, signal, context) => {
            v.parse(v.strictObject({}), input);
            await checkRun(context, signal, report);
            if (!bound)
                return {
                    configured: false,
                    reads: [],
                    actions: [],
                    operatorOnly: report ? [] : operatorOnly,
                    message:
                        "A dashboard automation account has not been connected for this owner. Use mira_dashboard_state for stored host, installed-version, backup, incident and job observations.",
                };
            const raw = await requestDashboard(
                bound,
                "automation.access",
                false,
                undefined,
                signal,
                request
            );
            const { capabilities } = v.parse(
                v.object({ capabilities: v.array(capabilitySchema) }),
                raw
            );
            const granted = (
                entries: Readonly<
                    Record<
                        string,
                        { requires: readonly Capability[]; arguments?: string }
                    >
                >
            ) =>
                Object.entries(entries)
                    .filter(([, entry]) =>
                        entry.requires.every((scope) => capabilities.includes(scope))
                    )
                    .map(([name, entry]) => ({
                        name,
                        arguments: entry.arguments ?? "none",
                    }));
            await checkRun(context, signal, report);
            return {
                configured: true,
                reads: granted(dashboardReads),
                actions: report ? [] : granted(dashboardActions),
                operatorOnly: report ? [] : operatorOnly,
            };
        },
    };
    if (!bound) return [access];
    const read: MiraToolDefinition = {
        name: "mira_dashboard_read",
        description:
            "Read a dashboard view using the arguments from mira_dashboard_access. For large results follow fields with path (string keys or array indices) and use nextOffset for the next page of an array. Normal source pagination uses its own cursor.",
        inputSchema: object(
            {
                view: { enum: readNames },
                arguments: argumentsField,
                path: { type: "array", items: { type: "string" }, maxItems: 12 },
                offset: { type: "integer", minimum: 0 },
            },
            ["view"]
        ),
        readOnly: true,
        automatic: !!report,
        action: async (input, signal, context) => {
            const args = v.parse(
                v.strictObject({
                    view: v.picklist(readNames),
                    arguments: fields,
                    path: v.optional(pathSchema, []),
                    offset: v.optional(
                        v.pipe(
                            v.number(),
                            v.integer(),
                            v.minValue(0),
                            v.maxValue(2_097_152)
                        ),
                        0
                    ),
                }),
                input
            );
            const entry = dashboardReads[args.view];
            const hasArguments = Object.keys(args.arguments ?? {}).length > 0;
            if (!("arguments" in entry) && hasArguments)
                throw new MiraFailure("BAD_REQUEST", "This view takes no arguments.");
            await checkRun(context, signal, report);
            const defaultArguments =
                "arguments" in entry && !("optionalInput" in entry) ? {} : undefined;
            const result = await requestDashboard(
                bound,
                entry.route,
                false,
                hasArguments ? args.arguments : defaultArguments,
                signal,
                request
            );
            await checkRun(context, signal, report);
            return portion(result, args.path, args.offset);
        },
    };
    if (report) return [access, read];
    return [
        access,
        read,
        {
            name: "mira_dashboard_request",
            description:
                "Carry out an operational dashboard action explicitly requested by the operator. Discover grants and argument formats with mira_dashboard_access. Read current targets, versions and revisions first. Reuse the same requestId for the same intended job. Returned job IDs indicate submission; inspect job_detail to confirm the final outcome.",
            inputSchema: object(
                { action: { enum: actionNames }, arguments: argumentsField },
                ["action", "arguments"]
            ),
            automatic: false,
            commitsIndependently: true,
            action: async (input, signal, context) => {
                const args = v.parse(
                    v.strictObject({
                        action: v.picklist(actionNames),
                        arguments: v.record(v.string(), v.unknown()),
                    }),
                    input
                );
                const entry = dashboardActions[args.action];
                const parameters =
                    entry.route === "jobs.run"
                        ? v.parse(v.strictObject({ requestId: idSchema }), args.arguments)
                        : args.arguments;
                await checkRun(context, signal);
                return requestDashboard(
                    bound,
                    entry.route,
                    true,
                    { ...parameters, ...("fixed" in entry ? entry.fixed : {}) },
                    signal,
                    request
                );
            },
        },
    ];
}
