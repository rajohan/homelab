import type { MiraHostCommand } from "@homelab/contracts/miraOperations";
import * as v from "valibot";

import { MiraFailure } from "../data/context";
import type { MiraToolContext, MiraToolDefinition } from "../executor/toolDefinition";
import { sandboxPathSchema } from "../sandbox/edits";
import program from "./workspace.py" with { type: "text" };

const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const fileLimit = 262_144;
const assignment = v.strictObject({
    childThreadId: v.pipe(v.string(), v.uuid()),
    checkout: v.pipe(v.string(), v.maxLength(1024), v.regex(/^\/[^\r\n\0]+$/)),
    paths: v.pipe(v.array(sandboxPathSchema), v.minLength(1), v.maxLength(100)),
});
const read = v.strictObject({
    path: v.optional(sandboxPathSchema),
    search: v.optional(v.pipe(v.string(), v.maxLength(240))),
    offset: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(fileLimit)),
        0
    ),
});
const edit = v.strictObject({
    path: sandboxPathSchema,
    beforeSha256: v.nullable(digest),
    content: v.nullable(v.pipe(v.string(), v.maxLength(fileLimit))),
});
const filePath = {
    type: "string",
    description: "An exact assigned repository-relative path.",
};
const commit = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const identitySchema = v.object({
    identity: v.tuple([v.string(), v.string(), v.string(), commit]),
});
type Identity = v.InferOutput<typeof identitySchema>["identity"];
type Dispatch = (
    input: MiraHostCommand,
    signal: AbortSignal,
    epoch?: string | null
) => Promise<{ stdout: string; truncated: boolean }>;
type Grant = {
    checkout: string;
    paths: Set<string>;
    identity: Identity;
    epoch: string | null;
};

/** Expose per-child source assignments only inside one owner-initiated chat turn.
 * @param dispatch - The existing leased, cancellable main-host transport.
 * @param access - Reads and rechecks the operator's current permission epoch.
 * @returns Parent assignment and child file tools backed by the same development checkout.
 */
export function createWorkspaceTools(
    dispatch: Dispatch,
    access: (signal: AbortSignal, epoch?: string | null) => Promise<string | null>
): MiraToolDefinition[] {
    const grants = new Map<string, Grant>();
    const invoke = async (request: object, epoch: string | null, signal: AbortSignal) => {
        const command =
            "exec /usr/bin/python3 -I -c '" +
            program.replaceAll("'", String.raw`'\''`) +
            "' <<'MIRA_WORKSPACE_INPUT'\n" +
            JSON.stringify(request) +
            "\nMIRA_WORKSPACE_INPUT";
        const result = await dispatch(
            {
                target: "main",
                command,
                reason: "Work on assigned development files.",
                timeoutSeconds: 30,
            },
            signal,
            epoch
        );
        if (result.truncated) throw new Error("Workspace result was truncated.");
        const data: unknown = JSON.parse(result.stdout);
        if (
            data &&
            typeof data === "object" &&
            "error" in data &&
            typeof data.error === "string"
        )
            throw new MiraFailure("CONFLICT", data.error);
        return data;
    };
    const grantFor = (context: MiraToolContext, writablePath?: string) => {
        const grant = context.childThreadId && grants.get(context.childThreadId);
        if (!grant || (writablePath && !grant.paths.has(writablePath)))
            throw new MiraFailure(
                "FORBIDDEN",
                "Ask the parent to assign this file to your thread."
            );
        return grant;
    };
    return [
        {
            name: "mira_workspace_assign",
            automatic: false,
            description:
                "Assign exact source paths in an existing development Git checkout on main to one spawned child thread for this chat run. Spawn the worker first, use its verified thread ID here, then message it the paths. Additional assignments extend the same checkout. The child edits the shared working tree, so you can inspect and integrate its diff directly.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["childThreadId", "checkout", "paths"],
                properties: {
                    childThreadId: { type: "string", format: "uuid" },
                    checkout: {
                        type: "string",
                        description:
                            "Canonical absolute root of the task worktree on main.",
                    },
                    paths: { type: "array", items: filePath, minItems: 1, maxItems: 100 },
                },
            },
            action: async (input, signal, context) => {
                if (context.childThreadId)
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "Only the parent may assign files."
                    );
                const value = v.parse(assignment, input);
                const epoch = await access(signal);
                const { identity } = v.parse(
                    identitySchema,
                    await invoke(
                        { checkout: value.checkout, operation: "assign" },
                        epoch,
                        signal
                    )
                );
                const previous = grants.get(value.childThreadId);
                if (
                    previous &&
                    (previous.checkout !== value.checkout ||
                        previous.epoch !== epoch ||
                        previous.identity.some((part, index) => part !== identity[index]))
                )
                    throw new MiraFailure(
                        "CONFLICT",
                        "Assign a new worker to the changed checkout or permission scope."
                    );
                const paths = new Set([...(previous?.paths ?? []), ...value.paths]);
                if (paths.size > 100)
                    throw new MiraFailure(
                        "CONFLICT",
                        "A child assignment supports up to 100 files."
                    );
                grants.set(value.childThreadId, {
                    epoch,
                    identity,
                    checkout: value.checkout,
                    paths,
                });
                return {
                    childThreadId: value.childThreadId,
                    paths: [...paths],
                    branch: identity[2] || null,
                    commit: identity[3],
                };
            },
        },
        {
            name: "mira_workspace_read",
            automatic: false,
            readOnly: true,
            description:
                "Call with {} for your verified child thread ID and assigned paths. Tell the parent your ID if needed. With search, list matching tracked source paths (empty string lists all). With path, read a tracked or explicitly assigned UTF-8 file from the shared checkout. Follow nextOffset until null. Use the current sha256 when editing an assigned file.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    path: filePath,
                    search: { type: "string", maxLength: 240 },
                    offset: { type: "integer", minimum: 0 },
                },
            },
            action: async (input, signal, context) => {
                const value = v.parse(read, input);
                if (value.path && value.search !== undefined)
                    throw new MiraFailure("CONFLICT", "Choose a file path or a search.");
                if (!value.path && value.search === undefined) {
                    if (!context.childThreadId)
                        throw new MiraFailure(
                            "FORBIDDEN",
                            "Only a subagent owns a file assignment."
                        );
                    await access(signal);
                    return {
                        childThreadId: context.childThreadId,
                        paths: [...(grants.get(context.childThreadId)?.paths ?? [])],
                    };
                }
                const grant = grantFor(context);
                return invoke(
                    {
                        ...value,
                        checkout: grant.checkout,
                        identity: grant.identity,
                        operation: value.path ? "read" : "list",
                        trackedOnly: !!value.path && !grant.paths.has(value.path),
                    },
                    grant.epoch,
                    signal
                );
            },
        },
        {
            name: "mira_workspace_edit",
            automatic: false,
            commitsIndependently: true,
            description:
                "Edit one assigned text file directly in the parent chat's working tree. Supply the entire new content and the sha256 you read. Use a null hash to create a new file and null content to delete an existing file. A stale hash requires a fresh read. Report the changed paths to the parent.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["path", "content", "beforeSha256"],
                properties: {
                    path: filePath,
                    content: { type: ["string", "null"], maxLength: fileLimit },
                    beforeSha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
                },
            },
            action: async (input, signal, context) => {
                const value = v.parse(edit, input);
                const grant = grantFor(context, value.path);
                return invoke(
                    {
                        ...value,
                        checkout: grant.checkout,
                        identity: grant.identity,
                        operation: "edit",
                    },
                    grant.epoch,
                    signal
                );
            },
        },
    ];
}
