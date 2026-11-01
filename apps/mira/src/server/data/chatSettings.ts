import {
    miraChatSettingsSchema,
    miraModelSchema,
    type MiraChatSettings,
    type MiraModel,
    type miraChatSettingsUpdateSchema,
} from "@homelab/contracts/mira";
import * as v from "valibot";

import { isSyntheticModel } from "../runtime/syntheticCatalog";
import { auditMira, MiraFailure, type MiraContext, type MiraQuery } from "./context";

/**
 * Resolve the automatic model for accounts without the owner-bound subscription.
 * @param models - Current catalog, including the native provider's default marker.
 * @param deploymentDefault - Configured default; an unavailable native choice remains unavailable.
 * @returns The configured native model or the native provider default when Synthetic is owner-bound.
 */
export function miraNativeDefaultModel(
    models: MiraModel[],
    deploymentDefault: string | null
): string | null {
    return deploymentDefault && !isSyntheticModel(deploymentDefault)
        ? deploymentDefault
        : (models.find((entry) => entry.isDefault && !isSyntheticModel(entry.model))
              ?.model ?? null);
}

/**
 * Resolve one turn from the current runtime catalog, rejecting unsupported combinations.
 * @param models - Validated catalog from this runtime instance.
 * @param requested - Human-selected conversation preferences, frozen when the turn was queued.
 * @param defaultModel - Deployment default, used only for an automatic model selection.
 * @returns Exact model and supported settings for this turn, without a silent model fallback.
 */
export function resolveMiraChatSettings(
    models: MiraModel[],
    requested: MiraChatSettings,
    defaultModel?: string | null
): { model: string; effort: string | null; serviceTier: string | null } {
    const settings = v.parse(miraChatSettingsSchema, requested);
    const selected =
        settings.model ?? defaultModel ?? models.find((entry) => entry.isDefault)?.model;
    const model = models.find((entry) => entry.model === selected);
    if (!model)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "The selected model is unavailable. Choose another model in Chat settings."
        );
    const effort = settings.effort ?? model.defaultReasoningEffort;
    if (
        effort !== null &&
        !model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === effort)
    )
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose a thinking level supported by this model."
        );
    const serviceTier = settings.serviceTier ?? model.defaultServiceTier;
    if (
        serviceTier !== null &&
        !model.serviceTiers.some((entry) => entry.id === serviceTier)
    )
        throw new MiraFailure("BAD_REQUEST", "Choose a speed supported by this model.");
    return { model: model.model, effort, serviceTier };
}

/**
 * Read advertised model choices without loading provider credentials into the dashboard.
 * @param context - Authenticated human operator context.
 * @returns Catalog, deployment default and freshness; availability is rechecked before inference.
 */
export async function listMiraModels(context: MiraContext) {
    return readCatalog(context.client, context.owner);
}

async function readCatalog(query: MiraQuery, owner: string) {
    const [row] = await query<
        {
            models: unknown;
            model: string | null;
            fresh: boolean;
            syntheticOwner: string | null;
        }[]
    >`SELECT models, model, synthetic_owner AS "syntheticOwner", ready AND heartbeat_at > now() - interval '45 seconds' AS fresh FROM mira_runtime_status WHERE id = 1`;
    const parsed = v.safeParse(
        v.pipe(v.array(miraModelSchema), v.maxLength(2100)),
        row?.models ?? []
    );
    const models = parsed.success ? parsed.output : [];
    return {
        models: models.filter(
            (entry) => !isSyntheticModel(entry.model) || row?.syntheticOwner === owner
        ),
        defaultModel:
            row?.model && isSyntheticModel(row.model) && row.syntheticOwner !== owner
                ? miraNativeDefaultModel(models, row.model)
                : (row?.model ?? null),
        fresh: row?.fresh === true,
    };
}

/**
 * Persist chat settings per conversation, preserving active turns and rejecting stale edits.
 * @param context - Signed-in owner; model tools cannot change these settings.
 * @param input - Expected conversation version and explicit model, effort and speed preferences.
 * @returns Completion after validated settings and audit commit together.
 */
export async function saveMiraChatSettings(
    context: MiraContext,
    input: v.InferOutput<typeof miraChatSettingsUpdateSchema>
): Promise<void> {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the operator can change Chat permissions."
        );
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const [conversation] = await query<
            { id: string; settings: MiraChatSettings }[]
        >`SELECT id,settings FROM mira_conversations WHERE id = ${input.id} AND owner = ${context.owner} AND version = ${input.version} AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;
        if (!conversation)
            throw new MiraFailure(
                "CONFLICT",
                "The conversation changed. Refresh before saving settings."
            );
        const [active] = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE conversation_id = ${input.id} AND state IN ('queued','running') LIMIT 1`;
        if (active)
            throw new MiraFailure(
                "CONFLICT",
                "Wait for the reply or stop it before changing chat settings."
            );
        if (
            conversation.settings.model !== input.settings.model ||
            conversation.settings.effort !== input.settings.effort ||
            conversation.settings.serviceTier !== input.settings.serviceTier
        ) {
            const catalog = await readCatalog(query, context.owner);
            if (!catalog.fresh)
                throw new MiraFailure(
                    "PRECONDITION_FAILED",
                    "Reconnect Mira before changing model settings."
                );
            resolveMiraChatSettings(catalog.models, input.settings, catalog.defaultModel);
        }
        if (
            (conversation.settings.permissionMode ?? "ask") !==
            (input.settings.permissionMode ?? "ask")
        )
            await query`UPDATE mira_runs SET approval_revoked_at=clock_timestamp() WHERE conversation_id=${input.id} AND owner=${context.owner} AND approval_revoked_at IS NULL`;
        await query`UPDATE mira_conversations SET settings = ${JSON.stringify(input.settings)}::text::jsonb, version = version + 1, updated_at = now() WHERE id = ${input.id}`;
        await auditMira(query, context, "conversation.settings_changed", input.id);
    });
}

/**
 * Validate an explicit automation model choice against its owner's current catalog.
 * @param query - Transaction saving the automation definition.
 * @param owner - Verified operator, never taken from the submitted form.
 * @param settings - Requested model preferences; null defaults remain editable while a provider is offline.
 * @returns Completion after capability and availability validation.
 */
export async function validateMiraAutomationSettings(
    query: MiraQuery,
    owner: string,
    settings: MiraChatSettings
): Promise<void> {
    const parsed = v.parse(miraChatSettingsSchema, settings);
    if (parsed.model === null && parsed.effort === null && parsed.serviceTier === null)
        return;
    const catalog = await readCatalog(query, owner);
    if (!catalog.fresh)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Reconnect Mira before changing model settings."
        );
    resolveMiraChatSettings(catalog.models, parsed, catalog.defaultModel);
}
