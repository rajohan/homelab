import {
    miraMemoryInputSchema,
    miraProgressInputSchema,
    miraTaskInputSchema,
    miraTaskUpdateSchema,
    type MiraProposal,
    type miraProposalDecisionSchema,
} from "@homelab/contracts/mira";
import * as v from "valibot";

import { auditMira, MiraFailure, type MiraContext } from "./context";
import { saveMemory } from "./documents";
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
            return v.parse(miraTaskInputSchema, input);
        }
        case "mira_task_update": {
            return v.parse(miraTaskUpdateSchema, input);
        }
        case "mira_task_progress": {
            return v.parse(miraProgressInputSchema, input);
        }
        case "mira_memory_create": {
            return v.parse(miraMemoryInputSchema, input);
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
    >`SELECT t.id,t.tool,t.input_hash AS "inputHash",t.proposal AS input,t.created_at::text AS "createdAt" FROM mira_tool_receipts t JOIN mira_runs r ON r.id=t.run_id JOIN mira_conversations c ON c.id=r.conversation_id WHERE r.owner=${context.owner} AND c.owner=${context.owner} AND c.id=${conversationId} AND c.deleted_at IS NULL AND t.state='awaiting_approval' AND t.proposal IS NOT NULL AND t.created_at > now()-interval '24 hours' ORDER BY t.id LIMIT 20`;
}

/**
 * Apply exactly the reviewed proposal once, atomically with its human audit receipt.
 * @param context - Signed-in human; model-run contexts cannot approve their own proposals.
 * @param input - Immutable receipt identity, reviewed argument hash and explicit decision.
 * @returns The durable decision, including after a lost response or concurrent retry.
 */
export async function decideMiraProposal(
    context: MiraContext,
    input: v.InferOutput<typeof miraProposalDecisionSchema>
) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the signed-in operator can approve proposed changes."
        );
    return context.client.begin(async (query) => {
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
        >`SELECT id FROM mira_conversations WHERE id=${link.conversationId} AND owner=${context.owner} AND deleted_at IS NULL FOR SHARE`;
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
        if (input.approve) {
            switch (proposal.tool) {
                case "mira_task_create": {
                    await saveTask(scoped, v.parse(miraTaskInputSchema, proposal.input));
                    break;
                }
                case "mira_task_update": {
                    await saveTask(scoped, v.parse(miraTaskUpdateSchema, proposal.input));
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
