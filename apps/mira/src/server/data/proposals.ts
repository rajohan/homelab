import {
    miraMemoryInputSchema,
    type MiraMessagePart,
    miraProgressInputSchema,
    type MiraProposal,
    type miraProposalDecisionSchema,
    type miraQuestionAnswerSchema,
    miraQuestionRequestSchema,
    miraTaskInputSchema,
    miraTaskUpdateSchema,
} from "@homelab/contracts/mira";
import { miraHostProposalSchema } from "@homelab/contracts/miraOperations";
import * as v from "valibot";

import type { MiraToolDefinition } from "../executor/toolDefinition";
import { sendMiraMessageInTransaction } from "./chatSteering";
import { auditMira, lockMiraProposals, type MiraContext, MiraFailure } from "./context";
import { saveMemory } from "./documents";
import type { MiraClaim } from "./queue";
import { addTaskProgress, saveTask } from "./tasks";

/**
 * Validate a model proposal against the fixed set of human-confirmed product writes.
 * @param tool - Host-defined tool name; unsupported actions fail closed.
 * @param input - Untrusted model arguments, normalized before display and approval.
 * @returns The exact validated fields the operator must review.
 */
export function parseMiraProposal(tool: string, input: unknown): Record<string, unknown> {
    switch (tool) {
        case "mira_task_create": {
            return v.parse(v.omit(miraTaskInputSchema, ["autoStart"]), input);
        }
        case "mira_task_update": {
            return v.parse(v.omit(miraTaskUpdateSchema, ["autoStart"]), input);
        }
        case "mira_task_progress": {
            return v.parse(miraProgressInputSchema, input);
        }
        case "mira_memory_create": {
            return v.parse(miraMemoryInputSchema, input);
        }
        case "mira_homelab_command": {
            return v.parse(miraHostProposalSchema, input);
        }
        default: {
            throw new MiraFailure("FORBIDDEN", "This action cannot be approved here.");
        }
    }
}

/**
 * Read bounded proposals from an owned conversation without executing their contents.
 * @param context - Verified human account.
 * @param conversationId - Conversation whose proposed changes are being reviewed.
 * @returns At most twenty unexpired proposals, oldest first.
 */
export async function listMiraProposals(context: MiraContext, conversationId: string) {
    return context.client<
        MiraProposal[]
    >`SELECT t.id,t.tool,t.input_hash AS "inputHash",t.proposal AS input,t.created_at::text AS "createdAt",t.message FROM mira_tool_receipts t JOIN mira_runs r ON r.id=t.run_id JOIN mira_conversations c ON c.id=r.conversation_id WHERE r.owner=${context.owner} AND c.owner=${context.owner} AND c.id=${conversationId} AND c.deleted_at IS NULL AND c.archived_at IS NULL AND (t.tool NOT IN ('mira_homelab_command','mira_request_user_input') OR (r.state IN ('running','completed') AND NOT r.cancel_requested AND (t.tool='mira_request_user_input' OR r.approval_revoked_at::text IS NOT DISTINCT FROM t.proposal->>'permissionEpoch') AND NOT EXISTS(SELECT 1 FROM mira_tasks task WHERE task.id=r.task_id AND task.owner=r.owner AND (task.deleted_at IS NOT NULL OR task.work_stopped_at>=r.created_at)))) AND t.state='awaiting_approval' AND t.proposal IS NOT NULL AND t.created_at > now()-interval '24 hours' ORDER BY t.id LIMIT 20`;
}

/**
 * Apply exactly the reviewed proposal once, atomically with its human audit receipt.
 * @param context - Signed-in human; model-run contexts cannot approve their own proposals.
 * @param input - Immutable receipt identity, reviewed argument hash and explicit decision.
 * @param hostVerified - Set only by the human API after fresh MFA for host commands.
 * @returns The durable decision, including after a lost response or concurrent retry.
 */
export async function decideMiraProposal(
    context: MiraContext,
    input: v.InferOutput<typeof miraProposalDecisionSchema>,
    hostVerified = false
) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the signed-in operator can approve proposed changes."
        );
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:request:${context.owner}:${input.id}`},0))`;
        await lockMiraProposals(query, context.owner);
        const decision = input.approve ? "approved" : "rejected";
        const readDecision = async () => {
            const [receipt] = await query<
                { conversationId: string; inputHash: string; state: string }[]
            >`SELECT r.conversation_id AS "conversationId",t.input_hash AS "inputHash",t.state FROM mira_tool_receipts t JOIN mira_runs r ON r.id=t.run_id WHERE t.id=${input.id} AND r.owner=${context.owner}`;
            if (!receipt)
                throw new MiraFailure("NOT_FOUND", "Proposed change not found.");
            if (receipt.inputHash !== input.inputHash)
                throw new MiraFailure(
                    "CONFLICT",
                    "The proposed change differs from the reviewed content."
                );
            return receipt;
        };
        const link = await readDecision();
        if (link.state === decision) return { state: decision };
        const [conversation] = await query<
            { id: string }[]
        >`SELECT id FROM mira_conversations WHERE id=${link.conversationId} AND owner=${context.owner} AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;
        if (!conversation) {
            // A committed decision followed by deletion may have raced the first read.
            const completed = await readDecision();
            if (completed.state === decision) return { state: decision };
            throw new MiraFailure("NOT_FOUND", "Conversation not found.");
        }
        const [proposal] = await query<
            {
                tool: string;
                inputHash: string;
                input: unknown;
                state: string;
                fresh: boolean;
            }[]
        >`SELECT tool,input_hash AS "inputHash",proposal AS input,state,created_at > now()-interval '24 hours' AS fresh FROM mira_tool_receipts WHERE id=${input.id} FOR UPDATE`;
        if (!proposal || proposal.inputHash !== input.inputHash)
            throw new MiraFailure(
                "CONFLICT",
                "The proposed change differs from the reviewed content."
            );
        if (proposal.state === decision) return { state: decision };
        if (proposal.state !== "awaiting_approval" || !proposal.fresh)
            throw new MiraFailure(
                "CONFLICT",
                "This proposal is no longer awaiting approval. Request a fresh proposal if needed."
            );
        const scoped: MiraContext = { ...context, transaction: query };
        if (proposal.tool === "mira_homelab_command") {
            if (input.approve && !hostVerified)
                throw new MiraFailure(
                    "FORBIDDEN",
                    "Host command approval requires a freshly verified operator."
                );
            v.parse(miraHostProposalSchema, proposal.input);
            const [live] = await query<
                { id: string }[]
            >`SELECT r.id FROM mira_runs r JOIN mira_tool_receipts t ON t.run_id=r.id WHERE t.id=${input.id} AND r.owner=${context.owner} AND (r.state='completed' OR (r.state='running' AND r.lease_expires_at>clock_timestamp())) AND NOT r.cancel_requested AND (r.approval_revoked_at::text IS NOT DISTINCT FROM t.proposal->>'permissionEpoch') AND r.manual AND r.automation_id IS NULL AND NOT EXISTS(SELECT 1 FROM mira_tasks task WHERE task.id=r.task_id AND task.owner=r.owner AND (task.deleted_at IS NOT NULL OR task.work_stopped_at>=r.created_at)) FOR UPDATE OF r`;
            if (!live)
                throw new MiraFailure(
                    "CONFLICT",
                    "This command was stopped or its authorization expired. Request a fresh proposal."
                );
            await query`UPDATE mira_tool_receipts SET state=${decision},proposal=${JSON.stringify(proposal.input)}::text::jsonb,message=${input.approve ? "The operator approved this exact host command." : "The operator rejected this host command."},finished_at=now() WHERE id=${input.id}`;
            await sendMiraMessageInTransaction(query, context, {
                conversationId: link.conversationId,
                requestId: input.id,
                text: input.approve
                    ? `I approved host command request ${input.id}. Continue with mira_homelab_resume using this request ID. This approval covers only the saved command.`
                    : `I rejected host command request ${input.id}. Do not execute or recreate it.`,
                attachmentIds: [],
            });
            await auditMira(query, context, `proposal.${decision}`, input.id);
            return { state: decision };
        }
        if (input.approve) {
            switch (proposal.tool) {
                case "mira_task_create": {
                    await saveTask(
                        scoped,
                        v.parse(
                            v.omit(miraTaskInputSchema, ["autoStart"]),
                            proposal.input
                        )
                    );
                    break;
                }
                case "mira_task_update": {
                    await saveTask(
                        scoped,
                        v.parse(
                            v.omit(miraTaskUpdateSchema, ["autoStart"]),
                            proposal.input
                        )
                    );
                    break;
                }
                case "mira_task_progress": {
                    const parsed = v.parse(miraProgressInputSchema, proposal.input);
                    await addTaskProgress(scoped, parsed.taskId, parsed.text);
                    break;
                }
                case "mira_memory_create": {
                    await saveMemory(
                        scoped,
                        v.parse(miraMemoryInputSchema, proposal.input)
                    );
                    break;
                }
                default: {
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "This action cannot be approved here."
                    );
                }
            }
        }
        await query`UPDATE mira_tool_receipts SET state=${decision},proposal=NULL,message=${input.approve ? "The operator approved and applied this exact change." : "The operator rejected this change."},finished_at=now() WHERE id=${input.id}`;
        await auditMira(query, context, `proposal.${decision}`, input.id);
        return { state: decision };
    });
}

/**
 * Save questions as durable conversation requests, independently of provider turn lifetime.
 * @param run - Fenced manual run; automatic work cannot prompt the operator.
 * @returns The shared question tool used by either inference provider.
 */
export function createMiraQuestionTools(run: MiraClaim): MiraToolDefinition[] {
    if (!run.manual || run.automationId) return [];
    return [
        {
            name: "mira_request_user_input",
            automatic: false,
            transactional: true,
            description:
                "Ask one to three concise questions in Chat when a preference or missing fact materially changes the work. Suggested options are optional; the operator can always type an answer. Requests persist after this reply ends. This is not an action-approval tool: use the action's own approval flow. Continue independent work while awaiting answers; never treat silence or a preselected option as an answer.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["questions"],
                properties: {
                    questions: {
                        type: "array",
                        minItems: 1,
                        maxItems: 3,
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["id", "title"],
                            properties: {
                                id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
                                title: { type: "string", minLength: 1, maxLength: 1000 },
                                options: {
                                    type: "array",
                                    maxItems: 6,
                                    items: {
                                        type: "string",
                                        minLength: 1,
                                        maxLength: 240,
                                    },
                                },
                            },
                        },
                    },
                },
            },
            action: async (input, signal, context) => {
                signal.throwIfAborted();
                const request = v.parse(miraQuestionRequestSchema, input);
                const query = context.transaction!;
                await lockMiraProposals(query, run.owner);
                const [count] = await query<
                    { total: number }[]
                >`SELECT count(*)::int AS total FROM mira_tool_receipts t JOIN mira_runs r ON r.id=t.run_id WHERE r.owner=${run.owner} AND r.conversation_id=${run.conversationId} AND t.state='awaiting_approval' AND t.created_at>clock_timestamp()-interval '24 hours'`;
                if ((count?.total ?? 0) >= 20)
                    throw new MiraFailure(
                        "PRECONDITION_FAILED",
                        "There are already twenty pending requests. Wait for an answer."
                    );
                const hash = new Bun.CryptoHasher("sha256")
                    .update(JSON.stringify(request))
                    .digest("hex");
                const [saved] = await query<
                    { id: string }[]
                >`UPDATE mira_tool_receipts SET state='awaiting_approval',proposal=${JSON.stringify(request)}::text::jsonb,input_hash=${hash},message='Waiting for your answer.',finished_at=clock_timestamp() WHERE id=${context.receiptId} AND run_id=${run.id} AND state='running' AND EXISTS(SELECT 1 FROM mira_runs WHERE id=${run.id} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp()) RETURNING id`;
                if (!saved)
                    throw new MiraFailure("CONFLICT", "The question lost its run lease.");
                return {
                    requestId: saved.id,
                    state: "awaiting_answer",
                    message:
                        "The questions are visible above the Chat composer. They remain available after this reply ends; the operator's answer resumes the conversation.",
                };
            },
            finalize: (_context, signal) => {
                signal.throwIfAborted();
                return Promise.resolve();
            },
        },
    ];
}

/**
 * Save every human answer once and resume the conversation in the same transaction.
 * @param context - Signed-in operator; questions never grant action authority.
 * @param input - Exact request hash and one answer per displayed question.
 * @returns The durable answered state, also on an identical network retry.
 */
export async function answerMiraQuestion(
    context: MiraContext,
    input: v.InferOutput<typeof miraQuestionAnswerSchema>
) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure("FORBIDDEN", "Only the operator can answer questions.");
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:request:${context.owner}:${input.id}`},0))`;
        await lockMiraProposals(query, context.owner);
        const [link] = await query<
            { conversationId: string }[]
        >`SELECT r.conversation_id AS "conversationId" FROM mira_tool_receipts t JOIN mira_runs r ON r.id=t.run_id WHERE t.id=${input.id} AND r.owner=${context.owner} AND t.tool='mira_request_user_input'`;
        if (!link) throw new MiraFailure("NOT_FOUND", "Question not found.");
        const [chat] = await query<
            { id: string }[]
        >`SELECT id FROM mira_conversations WHERE id=${link.conversationId} AND owner=${context.owner} AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;
        if (!chat)
            throw new MiraFailure("NOT_FOUND", "Open the conversation before answering.");
        const [row] = await query<
            {
                state: string;
                inputHash: string;
                input: unknown;
                message: string | null;
                fresh: boolean;
                allowed: boolean;
            }[]
        >`SELECT t.state,t.input_hash AS "inputHash",t.proposal AS input,t.message,t.created_at>clock_timestamp()-interval '24 hours' AS fresh,(r.state IN ('running','completed') AND NOT r.cancel_requested AND NOT EXISTS(SELECT 1 FROM mira_tasks task WHERE task.id=r.task_id AND task.owner=r.owner AND (task.deleted_at IS NOT NULL OR task.work_stopped_at>=r.created_at))) AS allowed FROM mira_tool_receipts t JOIN mira_runs r ON r.id=t.run_id WHERE t.id=${input.id} FOR UPDATE OF t`;
        if (!row || row.inputHash !== input.inputHash)
            throw new MiraFailure(
                "CONFLICT",
                "The question differs from the displayed request."
            );
        const answer = JSON.stringify(
            Object.entries(input.answers).toSorted(([a], [b]) => a.localeCompare(b))
        );
        if (row.state === "succeeded" && row.message === answer)
            return { state: "answered" };
        if (row.state !== "awaiting_approval" || !row.fresh || !row.allowed)
            throw new MiraFailure(
                "CONFLICT",
                "This question was already answered or is no longer active."
            );
        const request = v.parse(miraQuestionRequestSchema, row.input);
        if (
            Object.keys(input.answers).length !== request.questions.length ||
            request.questions.some((question) => !input.answers[question.id])
        )
            throw new MiraFailure(
                "BAD_REQUEST",
                "Answer every question before submitting."
            );
        // Deliver one input to the selected model while preserving each question and
        // answer as a separate, ordered transcript bubble using existing reply parts.
        const parts: MiraMessagePart[] = [];
        let text = "Answers to Mira's questions:\n\n";
        for (const question of request.questions) {
            for (const [role, content] of [
                ["assistant", question.title],
                ["user", input.answers[question.id]!],
            ] as const) {
                parts.push({
                    id: Bun.randomUUIDv7(),
                    offset: text.match(/[\s\S]/gu)?.length ?? 0,
                    createdAt: new Date().toISOString(),
                    role,
                });
                text += `${content}\n\n`;
            }
        }
        await sendMiraMessageInTransaction(query, context, {
            conversationId: link.conversationId,
            requestId: input.id,
            text,
            attachmentIds: [],
        });
        const key = `${context.owner}:${input.id}`;
        await query`UPDATE mira_messages SET parts=${JSON.stringify(parts)}::text::jsonb
            WHERE id IN (SELECT user_message_id FROM mira_runs WHERE request_key=${key}
                UNION SELECT id FROM mira_chat_inputs WHERE request_key=${key})
            AND conversation_id=${link.conversationId}`;
        // Older pending requests already stored a combined question-only bubble.
        // The paired parts above now preserve its text in the same transaction.
        await query`DELETE FROM mira_messages WHERE id=${input.id}
            AND conversation_id=${link.conversationId} AND role='assistant'
            AND attachment_ids='[]'::jsonb`;
        await query`UPDATE mira_tool_receipts SET state='succeeded',message=${answer},proposal=NULL,finished_at=clock_timestamp() WHERE id=${input.id}`;
        await auditMira(query, context, "question.answered", input.id);
        return { state: "answered" };
    });
}
