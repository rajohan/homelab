import { miraCodeSaveSchema } from "@homelab/contracts/miraCode";
import { idSchema } from "@homelab/contracts/operations";
import type { SQL } from "bun";
import * as v from "valibot";

import { listMiraCode, saveMiraCode } from "../../data/code";
import { MiraFailure, type MiraContext } from "../../data/context";
import type { MiraClaim } from "../../data/queue";
import type { RuntimeTool } from "../../runtime/protocol";
import type { GitHubBinding } from "./configuration";

/**
 * Offer local code proposals and status without giving models GitHub credentials or approval authority.
 * @param client - Product database.
 * @param run - Fenced conversation claim.
 * @param binding - Nonsecret fixed operator mapping.
 * @returns Receipt-wrapped local tools; external publication is separately approved and dispatched.
 */
export function createGitHubTools(
    client: SQL,
    run: MiraClaim,
    binding?: GitHubBinding
): (Omit<RuntimeTool, "execute"> & {
    automatic: boolean;
    transactional?: boolean;
    action: (
        input: unknown,
        signal: AbortSignal,
        context: MiraContext
    ) => Promise<unknown>;
})[] {
    return [
        {
            name: "mira_code_proposals",
            automatic: true,
            description:
                "List local code proposals and GitHub publication status for this conversation. Pass nextCursor as before to read older entries. Published means a draft PR was created, not merged or deployed. needs_attention is never authority to resend an uncertain write.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { before: { type: "string" } },
            },
            action: async (input, signal) => {
                signal.throwIfAborted();
                const parsed = v.parse(
                    v.strictObject({ before: v.optional(idSchema) }),
                    input
                );
                return listMiraCode(
                    { client, owner: run.owner, actor: "mira" },
                    { ...parsed, conversationId: run.conversationId }
                );
            },
        },
        {
            name: "mira_code_draft",
            automatic: false,
            transactional: true,
            description:
                "Prepare a local GitHub draft proposal for rajohan/homelab using Mira. Select one completed fixed structured-edit check on Main or Daytona in this conversation, its exact base commit, a conventional PR title and description. The service captures the exact tested edit file. Publication requires dashboard approval or Full access through mira_action_execute. This draft tool cannot approve, publish, retry an uncertain write, merge, deploy or spend resources. Reuse the stable UUID/version for local edits only.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["id", "version", "checkId", "commit", "title", "body"],
                properties: {
                    id: { type: "string" },
                    version: { type: "integer", minimum: 0 },
                    checkId: { type: "string" },
                    commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
                    title: { type: "string", maxLength: 160 },
                    body: { type: "string", maxLength: 16_000 },
                },
            },
            action: async (input, signal, context) => {
                signal.throwIfAborted();
                if (!context.transaction)
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "Code drafts require the owned tool transaction."
                    );
                const parsed = v.parse(
                    v.strictObject({
                        id: idSchema,
                        version: miraCodeSaveSchema.entries.version,
                        ...miraCodeSaveSchema.entries.content.entries,
                    }),
                    input
                );
                const { id, version, ...content } = parsed;
                return saveMiraCode(
                    context,
                    { id, version, conversationId: run.conversationId, content },
                    binding
                );
            },
        },
    ];
}
