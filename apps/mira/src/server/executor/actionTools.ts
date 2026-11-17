import { miraDaytonaContentSchema as jobContentSchema } from "@homelab/contracts/miraDaytona";
import { versionedIdSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

import {
    type MiraActionKind,
    miraJobApprovalScope,
    miraManualRunAllowed,
} from "../data/approvalPolicy";
import { approveMiraCode, readMiraCode } from "../data/code";
import { MiraFailure } from "../data/context";
import { approveMiraDaytona, readMiraDaytona } from "../data/daytona";
import { approveMiraMail, readMiraMail } from "../data/mail";
import { approveMiraPublication, readMiraPublication } from "../data/publications";
import type { MiraClaim } from "../data/queue";
import { approveMiraSocial, readMiraSocial } from "../data/social";
import type { AgentMailBinding } from "../integrations/agentmail/configuration";
import type { GitHubBinding } from "../integrations/github/configuration";
import type { HereNowBinding } from "../integrations/herenow/configuration";
import type { MoltbookBinding } from "../integrations/moltbook/configuration";
import type { MiraActionReviewer } from "../operations/tools";
import type { CodeJobBinding } from "../sandbox/localBinding";
import type { MiraToolDefinition } from "./toolDefinition";

const executeSchema = v.strictObject({
    ...versionedIdSchema.entries,
    kind: v.picklist(["mail", "publication", "social", "code", "job"]),
    contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/**
 * Queue a saved action through the same checked permission path as the shared UI.
 * @param run - Trusted execution identity; drafts must belong to this conversation.
 * @param bindings - Server-selected mappings, including the chosen code target and file store.
 * @returns An internal transactional operation; providers are invoked later by their existing outboxes.
 */
function createActionExecutor(
    run: MiraClaim,
    bindings: {
        mail?: AgentMailBinding | undefined;
        publication?: HereNowBinding | undefined;
        social?: MoltbookBinding | undefined;
        code?: GitHubBinding | undefined;
        job?: CodeJobBinding | undefined;
        directory?: string | undefined;
    }
): MiraToolDefinition["action"] {
    return async (input, _signal, context) => {
        const value = v.parse(executeSchema, input);
        const query = context.transaction;
        if (!query)
            throw new MiraFailure(
                "CONFLICT",
                "Action execution requires its tool transaction."
            );
        const id = value.id;
        const validate = (draft: {
            conversationId: string | null;
            version: number;
            contentHash: string;
        }) => {
            if (
                draft.conversationId !== run.conversationId ||
                draft.version !== value.version ||
                draft.contentHash !== value.contentHash
            )
                throw new MiraFailure(
                    "CONFLICT",
                    "The saved action changed before it could be queued."
                );
        };
        // Keep each content type tied to its owned reader; approval rechecks version/hash under lock.
        switch (value.kind) {
            case "mail": {
                const draft = await readMiraMail(query, context.owner, id);
                validate(draft);
                return approveMiraMail(
                    context,
                    {
                        ...value,
                        reviewedReply: draft.content.reply ?? null,
                        reviewedAttachments: draft.content.attachments ?? [],
                    },
                    bindings.mail,
                    bindings.directory
                );
            }
            case "publication": {
                const draft = await readMiraPublication(query, context.owner, id);
                validate(draft);
                return approveMiraPublication(
                    context,
                    {
                        ...value,
                        reviewedContent: draft.content,
                    },
                    bindings.publication,
                    bindings.directory
                );
            }
            case "social": {
                const draft = await readMiraSocial(query, context.owner, id);
                validate(draft);
                return approveMiraSocial(
                    context,
                    {
                        ...value,
                        reviewedContent: draft.content,
                    },
                    bindings.social
                );
            }
            case "code": {
                const draft = await readMiraCode(query, context.owner, id);
                validate(draft);
                return approveMiraCode(
                    context,
                    {
                        ...value,
                        reviewedContent: draft.content,
                    },
                    bindings.code,
                    bindings.directory
                );
            }
            case "job": {
                const draft = await readMiraDaytona(query, context.owner, id);
                validate(draft);
                return approveMiraDaytona(
                    context,
                    {
                        ...value,
                        reviewedContent: draft.content,
                        executionTarget: draft.executionTarget,
                    },
                    bindings.job
                );
            }
        }
    };
}

const directActionKinds: Readonly<Record<string, MiraActionKind>> = {
    mira_mail_send: "mail",
    mira_mail_reply: "mail",
    mira_herenow_publish: "publication",
    mira_moltbook_publish: "social",
    mira_github_create_pr: "code",
    mira_code_run: "job",
    mira_code_check: "job",
    mira_code_edit: "job",
    mira_code_read_sources: "job",
};

const actionTables: Record<MiraActionKind, string> = {
    mail: "mira_mail_drafts",
    publication: "mira_publications",
    social: "mira_social_drafts",
    code: "mira_code_publications",
    job: "mira_daytona_jobs",
};

/**
 * Expose one direct operation, reviewing external effects outside its short SQL transactions.
 * @param definitions - Existing validated action builders and read tools.
 * @param run - Fenced manual run owning the request.
 * @param bindings - Server-selected integrations and execution target.
 * @param reviewer - Independent, tool-free reviewer; unavailable review asks the operator.
 * @returns Tools with direct local execution and one durable review/queue transition for external actions.
 */
export function directMiraActionTools(
    definitions: MiraToolDefinition[],
    run: MiraClaim,
    bindings: Parameters<typeof createActionExecutor>[1],
    reviewer?: MiraActionReviewer
): MiraToolDefinition[] {
    const execute = createActionExecutor(run, bindings);
    return definitions.map((definition) => {
        const kind = directActionKinds[definition.name];
        if (!kind) return definition;
        return {
            ...definition,
            transactional: false,
            commitsIndependently: true,
            description: `${definition.description} This is one direct action: local coding proceeds immediately; external effects receive independent automatic review. Only an unresolved review asks the operator in Chat. Queued means accepted, not completed. Inspect the normal result tool; never repeat an uncertain action.`,
            action: async (input, signal, context) => {
                const saved = await context.client.begin(async (query) => {
                    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
                    if (!(await miraManualRunAllowed(query, context)))
                        throw new MiraFailure(
                            "FORBIDDEN",
                            "Direct actions require an active owned manual run."
                        );
                    const record = v.parse(
                        v.object({
                            id: v.string(),
                            version: v.number(),
                            contentHash: v.string(),
                            state: v.string(),
                            message: v.optional(v.nullable(v.string())),
                            content: v.unknown(),
                            executionTarget: v.optional(v.string()),
                        }),
                        await definition.action(input, signal, {
                            ...context,
                            transaction: query,
                        })
                    );
                    const [origin] = await query<{ epoch: string | null }[]>`
                        SELECT approval_revoked_at::text AS epoch FROM mira_runs WHERE id=${run.id} AND owner=${run.owner}`;
                    return { record, epoch: origin!.epoch };
                });
                const { record, epoch } = saved;
                if (record.state !== "draft") return record;
                if (record.message?.startsWith("Automatic review ("))
                    return {
                        ...record,
                        state: "awaiting_approval",
                        approvalRequired: true,
                    };
                const actionScope = kind === "code" ? "code" : "external";
                const scope =
                    kind === "job"
                        ? miraJobApprovalScope(
                              record.id,
                              v.parse(jobContentSchema, record.content),
                              record.executionTarget
                          )
                        : actionScope;
                const verdict =
                    scope === "external"
                        ? await (reviewer?.(
                              {
                                  kind,
                                  contentHash: record.contentHash,
                                  content: record.content,
                                  ...(record.executionTarget
                                      ? { executionTarget: record.executionTarget }
                                      : {}),
                              },
                              signal
                          ) ??
                              Promise.resolve({
                                  decision: "ask" as const,
                                  reason: "Automatic review is unavailable. Review this exact action in Chat.",
                              }))
                        : {
                              decision: "approve" as const,
                              reason: "Requested code work proceeds directly.",
                          };
                signal.throwIfAborted();
                return context.client.begin(async (query) => {
                    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
                    if (!(await miraManualRunAllowed(query, context)))
                        throw new MiraFailure(
                            "FORBIDDEN",
                            "The run stopped during action review."
                        );
                    const [current] = await query<{ epoch: string | null }[]>`
                        SELECT approval_revoked_at::text AS epoch FROM mira_runs WHERE id=${run.id} AND owner=${run.owner}`;
                    if (current?.epoch !== epoch)
                        throw new MiraFailure(
                            "FORBIDDEN",
                            "Action authority changed during review."
                        );
                    const message = `Automatic review (${verdict.decision}): ${verdict.reason}`;
                    const receipt = await query<
                        { id: string }[]
                    >`UPDATE mira_tool_receipts SET message=${message},proposal=${JSON.stringify({ kind, id: record.id, contentHash: record.contentHash })}::text::jsonb WHERE id=${context.receiptId} AND run_id=${run.id} AND state='running' RETURNING id`;
                    if (!receipt[0])
                        throw new MiraFailure(
                            "CONFLICT",
                            "The action receipt changed during review."
                        );
                    if (verdict.decision !== "approve") {
                        const table = actionTables[kind];
                        const updated = await query<{ id: string }[]>`
                            UPDATE ${query(table)} SET message=${message},updated_at=clock_timestamp()
                            WHERE id=${record.id} AND owner=${context.owner} AND version=${record.version}
                            AND state='draft' AND content_hash=${record.contentHash} RETURNING id`;
                        if (!updated[0])
                            throw new MiraFailure(
                                "CONFLICT",
                                "The action changed during review. Inspect its current outcome."
                            );
                        return {
                            ...record,
                            state: "awaiting_approval",
                            approvalRequired: true,
                            message,
                        };
                    }
                    return execute(
                        {
                            kind,
                            id: record.id,
                            version: record.version,
                            contentHash: record.contentHash,
                        },
                        signal,
                        {
                            ...context,
                            transaction: query,
                            reviewedAction: {
                                id: record.id,
                                contentHash: record.contentHash,
                            },
                        }
                    );
                });
            },
        };
    });
}
