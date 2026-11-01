import { versionedIdSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

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
import type { CodeJobBinding } from "../sandbox/localBinding";
import type { MiraToolDefinition } from "./toolDefinition";

const executeSchema = v.strictObject({
    ...versionedIdSchema.entries,
    kind: v.picklist(["mail", "publication", "social", "code", "job"]),
    contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/**
 * Expose explicit draft execution through the same checked approvals as the shared UI.
 * @param run - Trusted execution identity; drafts must belong to this conversation.
 * @param bindings - Server-selected mappings, including the chosen code target and file store.
 * @returns One transactional tool; providers are invoked later by their existing outboxes.
 */
export function createMiraActionTools(
    run: MiraClaim,
    bindings: {
        mail?: AgentMailBinding | undefined;
        publication?: HereNowBinding | undefined;
        social?: MoltbookBinding | undefined;
        code?: GitHubBinding | undefined;
        job?: CodeJobBinding | undefined;
        directory?: string | undefined;
    }
): MiraToolDefinition[] {
    return [
        {
            name: "mira_action_execute",
            description:
                "Execute an existing draft for the operator's requested work. First read its complete saved content, version and contentHash. Kind job runs a code job; code publishes a tested draft GitHub PR; mail sends email; publication publishes here.now; social posts/replies on Moltbook. Ask for approval always requires a separate human decision. Approve for me permits only fixed Homelab source/edit/test jobs; Full access also permits the other enabled actions. This cannot grant integration access, merge, deploy, bypass browser/PC consent or start paused automations. Queued means accepted for execution, not completed: inspect the normal action status afterward.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    kind: { enum: ["mail", "publication", "social", "code", "job"] },
                    id: { type: "string", format: "uuid" },
                    version: { type: "integer", minimum: 1 },
                    contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
                required: ["kind", "id", "version", "contentHash"],
            },
            automatic: false,
            transactional: true,
            action: async (input, _signal, context) => {
                const value = v.parse(executeSchema, input);
                const query = context.transaction;
                if (!query)
                    throw new MiraFailure(
                        "CONFLICT",
                        "Draft execution requires its tool transaction."
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
                            "Read the current draft in this conversation before executing it."
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
            },
        },
    ];
}
