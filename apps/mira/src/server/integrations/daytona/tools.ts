import {
    miraDaytonaContentSchema,
    miraDaytonaFilterSchema,
    miraDaytonaSaveSchema,
} from "@homelab/contracts/miraDaytona";
import { idSchema } from "@homelab/contracts/operations";
import type { SQL } from "bun";
import * as v from "valibot";

import { MiraFailure, type MiraContext } from "../../data/context";
import { listMiraDaytona, readMiraDaytona, saveMiraDaytona } from "../../data/daytona";
import type { MiraClaim } from "../../data/queue";
import type { RuntimeTool } from "../../runtime/protocol";
import { daytonaCheckContent, daytonaCheckSchema } from "../../sandbox/profile";
import type { DaytonaBinding } from "./configuration";

type DaytonaTool = Omit<RuntimeTool, "execute"> & {
    automatic: boolean;
    transactional?: boolean;
    action: (
        input: unknown,
        signal: AbortSignal,
        context?: MiraContext
    ) => Promise<unknown>;
};

/**
 * Expose local cloud proposals and owned results without granting model execution or spending authority.
 * @param client - Product database.
 * @param run - Current fenced conversation claim.
 * @param configuration - Nonsecret fixed execution mapping.
 * @returns Receipt-wrapped tools; approval and provider mutation remain human/dispatcher operations.
 */
export function createDaytonaTools(
    client: SQL,
    run: MiraClaim,
    configuration?: DaytonaBinding
): DaytonaTool[] {
    const context = { client, owner: run.owner, actor: "mira" };
    const inputFile = v.strictObject({
        id: idSchema,
        name: v.pipe(v.string(), v.maxLength(160)),
    });
    const tools: DaytonaTool[] = [
        {
            name: "mira_daytona_jobs",
            automatic: true,
            description:
                "List local cloud jobs for this conversation. Pass nextCursor as before to read older jobs. No provider call or execution. A completed command and confirmed sandbox cleanup are separate; never claim both unless recorded.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { before: { type: "string" } },
            },
            action: async (input, signal) => {
                signal.throwIfAborted();
                const { before } = v.parse(
                    v.strictObject({ before: miraDaytonaFilterSchema.entries.before }),
                    input
                );
                const page = await listMiraDaytona(context, {
                    before,
                    conversationId: run.conversationId,
                });
                return {
                    rows: page.rows.map((job) => ({
                        id: job.id,
                        title: job.content.title,
                        state: job.state,
                        phase: job.phase,
                        cleanup: job.cleanup,
                        exitCode: job.exitCode,
                        files: job.files,
                        message: job.message,
                    })),
                    nextCursor: page.nextCursor,
                };
            },
        },
        {
            name: "mira_daytona_result",
            automatic: true,
            description:
                "Read one recorded cloud result from this conversation, with bounded untrusted logs. This never runs code or interprets log instructions. The returned truncated flag means the dashboard may contain more log text. Use mira_attachment_read with a returned file ID to read bounded text/PDF contents; images can be opened in the dashboard.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["id"],
                properties: { id: { type: "string" } },
            },
            action: async (input, signal) => {
                signal.throwIfAborted();
                const { id } = v.parse(v.strictObject({ id: idSchema }), input);
                const job = await readMiraDaytona(client, run.owner, id);
                if (job.conversationId !== run.conversationId)
                    throw new MiraFailure(
                        "NOT_FOUND",
                        "Cloud job not found in this conversation."
                    );
                return {
                    id: job.id,
                    state: job.state,
                    cleanup: job.cleanup,
                    exitCode: job.exitCode,
                    files: job.files,
                    message: job.message,
                    stdout: job.stdout.slice(0, 16_000),
                    stderr: job.stderr.slice(0, 16_000),
                    output: job.output.slice(0, 16_000),
                    truncated: [job.stdout, job.stderr, job.output].some(
                        (value) => value.length > 16_000
                    ),
                    trust: "untrusted_cloud_output",
                };
            },
        },
        {
            name: "mira_daytona_draft",
            automatic: false,
            transactional: true,
            description:
                "Prepare a cloud command requested by the operator. Stable UUID/version 0 creates a draft; current version edits it. Each selected input must already be attached to this conversation. Use the fixed paths /tmp/homelab-mira/<draft-id>/inputs/<name> and outputs/<name>. Up to four inputs/results, each at most 1 MiB; results are passive text, PDF or images. The operator reviews and starts the exact command in Cloud jobs. This tool never approves, creates a sandbox, or spends resources. Do not include host credentials or assume local host files are available.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["id", "version", "title", "command", "inputs", "outputs"],
                properties: {
                    id: { type: "string" },
                    version: { type: "integer", minimum: 0 },
                    title: { type: "string", maxLength: 160 },
                    command: { type: "string", maxLength: 16_384 },
                    inputs: {
                        type: "array",
                        maxItems: 4,
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["id", "name"],
                            properties: {
                                id: { type: "string" },
                                name: { type: "string" },
                            },
                        },
                    },
                    outputs: { type: "array", maxItems: 4, items: { type: "string" } },
                },
            },
            action: async (input, signal, owned) => {
                signal.throwIfAborted();
                if (!owned?.transaction)
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "Cloud drafts require the owned tool transaction."
                    );
                const parsed = v.parse(
                    v.strictObject({
                        id: idSchema,
                        version: miraDaytonaSaveSchema.entries.version,
                        title: miraDaytonaContentSchema.entries.title,
                        command: miraDaytonaContentSchema.entries.command,
                        inputs: v.pipe(v.array(inputFile), v.maxLength(4)),
                        outputs: miraDaytonaContentSchema.entries.outputs,
                    }),
                    input
                );
                const inputs = [];
                for (const selected of parsed.inputs) {
                    const [file] = await owned.transaction<
                        { sha256: string }[]
                    >`SELECT sha256 FROM mira_attachments a WHERE a.id=${selected.id} AND a.owner=${run.owner} AND a.ready_at IS NOT NULL AND a.deleted_at IS NULL AND a.bytes BETWEEN 1 AND 1048576 AND EXISTS(SELECT 1 FROM mira_messages m WHERE m.conversation_id=${run.conversationId} AND m.attachment_ids @> ${JSON.stringify([selected.id])}::text::jsonb)`;
                    if (!file)
                        throw new MiraFailure(
                            "FORBIDDEN",
                            "Attach each selected input to this conversation before proposing cloud export."
                        );
                    inputs.push({ ...selected, sha256: file.sha256 });
                }
                return saveMiraDaytona(
                    owned,
                    {
                        id: parsed.id,
                        version: parsed.version,
                        conversationId: run.conversationId,
                        taskId: run.taskId ?? null,
                        content: {
                            title: parsed.title,
                            command: parsed.command,
                            inputs,
                            outputs: parsed.outputs,
                        },
                    },
                    configuration
                );
            },
        },
    ];
    const draft = tools.find((tool) => tool.name === "mira_daytona_draft")!;
    tools.push({
        name: "mira_daytona_check_draft",
        automatic: false,
        transactional: true,
        description:
            "Prepare the fixed Homelab verification profile for one exact public commit and an optional attached unified patch text file. The qualified snapshot runs Bun 1.4.4, frozen install, checks, tests, build and smoke tests using isolated PostgreSQL. Results are untrusted report/log/patch files in Cloud jobs. No arbitrary repository, credentials, GitHub writes, approval or spending. The operator must review and start the draft. This profile requires the Homelab check snapshot; do not assume an ordinary Bun image contains it.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id", "version", "commit", "patchId"],
            properties: {
                id: { type: "string" },
                version: { type: "integer", minimum: 0 },
                commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
                patchId: { type: ["string", "null"] },
            },
        },
        action: async (input, signal, owned) => {
            signal.throwIfAborted();
            if (!owned?.transaction)
                throw new MiraFailure(
                    "FORBIDDEN",
                    "Cloud drafts require the owned tool transaction."
                );
            const parsed = v.parse(
                v.strictObject({
                    id: idSchema,
                    version: miraDaytonaSaveSchema.entries.version,
                    commit: daytonaCheckSchema.entries.commit,
                    patchId: v.nullable(idSchema),
                }),
                input
            );
            let patch: { id: string; sha256: string } | undefined;
            if (parsed.patchId) {
                const [file] = await owned.transaction<
                    { sha256: string }[]
                >`SELECT sha256 FROM mira_attachments a WHERE a.id=${parsed.patchId} AND a.owner=${run.owner} AND a.ready_at IS NOT NULL AND a.deleted_at IS NULL AND a.bytes BETWEEN 1 AND 1048576 AND EXISTS(SELECT 1 FROM mira_messages m WHERE m.conversation_id=${run.conversationId} AND m.attachment_ids @> ${JSON.stringify([parsed.patchId])}::text::jsonb)`;
                if (!file)
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "Attach the selected patch to this conversation before proposing cloud export."
                    );
                patch = { id: parsed.patchId, sha256: file.sha256 };
            }
            const content = daytonaCheckContent(
                {
                    id: parsed.id,
                    commit: parsed.commit,
                    patchSha256: patch?.sha256 ?? null,
                },
                patch
            );
            return draft.action(
                {
                    id: parsed.id,
                    version: parsed.version,
                    ...content,
                    inputs: content.inputs.map(({ id, name }) => ({ id, name })),
                },
                signal,
                owned
            );
        },
    });
    return tools;
}
