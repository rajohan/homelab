import { miraCodeContentSchema, type MiraCodeContent } from "@homelab/contracts/miraCode";
import {
    miraDaytonaContentSchema,
    type MiraDaytonaContent,
} from "@homelab/contracts/miraDaytona";
import * as v from "valibot";

import { parseSandboxEditPlan } from "../sandbox/edits";
import { daytonaEditContent } from "../sandbox/profile";
import {
    MiraFailure,
    requireConversation,
    type MiraContext,
    type MiraQuery,
} from "./context";
import { readMiraFile } from "./files";

/**
 * Bind a code proposal to one owned, successful fixed-profile edit check and its exact input.
 * @param query - Owner-controls-locked transaction or read handle.
 * @param context - Human or fenced model owner.
 * @param selected - Proposed metadata and exact base commit.
 * @param conversationId - The job's original conversation, never a cross-conversation export.
 * @returns Server-captured edit reference after checking successful execution and cleanup.
 */
export async function captureCodeSource(
    query: MiraQuery,
    context: MiraContext,
    selected: Omit<MiraCodeContent, "edits">,
    conversationId: string | null
): Promise<MiraCodeContent> {
    await requireConversation(query, context.owner, conversationId);
    const [job] = await query<
        { content: MiraDaytonaContent; conversationId: string | null }[]
    >`SELECT content,conversation_id AS "conversationId" FROM mira_daytona_jobs WHERE id=${selected.checkId} AND owner=${context.owner} AND state='completed' AND outcome='completed' AND cleanup='confirmed' AND exit_code=0 AND NOT cancel_requested AND phase='closed' FOR SHARE`;
    if (!job || job.conversationId !== conversationId)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Choose a successful edit check from this conversation with confirmed cleanup."
        );
    const tested = v.parse(miraDaytonaContentSchema, job.content);
    const edits = tested.inputs[0];
    if (!edits || edits.name !== "edits.json")
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose the fixed structured-edit check, not an arbitrary cloud command."
        );
    const expected = v.parse(
        miraDaytonaContentSchema,
        daytonaEditContent(
            { id: selected.checkId, commit: selected.commit, editsSha256: edits.sha256 },
            edits
        )
    );
    if (
        tested.command !== expected.command ||
        JSON.stringify(tested.inputs) !== JSON.stringify(expected.inputs) ||
        JSON.stringify(tested.outputs) !== JSON.stringify(expected.outputs)
    )
        throw new MiraFailure(
            "CONFLICT",
            "The check does not match the selected base and edit plan."
        );
    const [file] = await query<
        { sha256: string }[]
    >`SELECT sha256 FROM mira_attachments WHERE id=${edits.id} AND owner=${context.owner} AND ready_at IS NOT NULL AND deleted_at IS NULL AND bytes BETWEEN 1 AND 1048576 AND media_type='text/plain; charset=utf-8' FOR SHARE`;
    if (!file || file.sha256 !== edits.sha256)
        throw new MiraFailure("CONFLICT", "The tested edit plan is no longer available.");
    return v.parse(miraCodeContentSchema, {
        ...selected,
        edits: { id: edits.id, sha256: edits.sha256 },
    });
}

/**
 * Revalidate durable source provenance and exact selected bytes before review or publication.
 * @param context - Owner and optional transaction; credentials are never included.
 * @param content - Immutable captured proposal.
 * @param conversationId - Original owned conversation.
 * @param directory - Private attachment volume.
 * @returns Bounded verified plan bytes and parsed edits for explicit review.
 */
export async function readCodeSource(
    context: MiraContext,
    content: MiraCodeContent,
    conversationId: string | null,
    directory?: string
) {
    const { edits, ...selected } = v.parse(miraCodeContentSchema, content);
    const current = await captureCodeSource(
        context.transaction ?? context.client,
        context,
        selected,
        conversationId
    );
    if (current.edits.id !== edits.id || current.edits.sha256 !== edits.sha256)
        throw new MiraFailure(
            "CONFLICT",
            "The selected source changed. Review a new proposal."
        );
    const file = await readMiraFile(context, directory, edits.id);
    if (new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex") !== edits.sha256)
        throw new MiraFailure("CONFLICT", "The selected edit bytes changed.");
    return { bytes: file.bytes, plan: parseSandboxEditPlan(file.bytes, content.commit) };
}
