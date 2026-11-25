import { miraCodeSaveSchema } from "@homelab/contracts/miraCode";
import { idSchema } from "@homelab/contracts/operations";
import type { SQL } from "bun";
import * as v from "valibot";

import { listMiraCode, saveMiraCode } from "../../data/code";
import { type MiraContext, MiraFailure } from "../../data/context";
import type { MiraClaim } from "../../data/queue";
import { isMiraReportRun } from "../../data/reportAccess";
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
            name: "mira_github_publications",
            automatic: true,
            readOnly: isMiraReportRun(run),
            description:
                "Read GitHub publication outcomes for this conversation. Pass nextCursor as before for older entries. A confirmed PR is not merged or deployed. An uncertain result is never permission to resubmit.",
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
            name: "mira_github_create_pr",
            automatic: false,
            transactional: true,
            description:
                "Create a GitHub pull request for the requested tested Homelab change. Supply a stable UUID, version 0 for a new request, one completed structured-edit check in this conversation, its exact base commit, a conventional title and body. The service captures the tested source. This does not merge or deploy. Read mira_github_publications for the confirmed outcome.",
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
