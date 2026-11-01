import type { MiraModel } from "@homelab/contracts/mira";
import * as v from "valibot";

export const syntheticAliases = [
    "syn:large:text",
    "syn:small:text",
    "syn:large:vision",
    "syn:small:vision",
] as const;

const label = v.pipe(v.string(), v.minLength(1), v.maxLength(160));
const reasoningSchema = v.object({
    efforts: v.optional(v.pipe(v.array(label), v.maxLength(32)), []),
});
const modelSchema = v.object({
    id: label,
    description: v.optional(v.pipe(v.string(), v.maxLength(4000)), ""),
    alias_of: v.optional(label),
    always_on: v.optional(v.boolean(), false),
    supported_features: v.optional(v.array(label), []),
    input_modalities: v.optional(v.array(label), []),
    output_modalities: v.optional(v.array(label), []),
    reasoning_parameters: v.optional(reasoningSchema),
});
const catalogSchema = v.object({ data: v.pipe(v.array(modelSchema), v.maxLength(2100)) });

/**
 * Recognize the four subscription aliases supported by Mira; concrete and paid-only IDs are not selected implicitly.
 * @param model - Persisted selection or provider catalog identifier.
 * @returns Whether it is an exact supported Synthetic alias.
 */
export function isSyntheticModel(model: string | null | undefined): boolean {
    return syntheticAliases.some((alias) => alias === model);
}

/**
 * Convert current provider capabilities without replacing the selected alias with its temporary target.
 * @param input - Untrusted response from Synthetic's documented model inventory.
 * @returns Available subscription aliases supporting text output and tools, with current thinking/image capabilities.
 */
export function syntheticModels(input: unknown): MiraModel[] {
    const { data } = v.parse(catalogSchema, input);
    if (new Set(data.map((entry) => entry.id)).size !== data.length)
        throw new Error("Synthetic returned duplicate model identifiers.");
    return syntheticAliases.flatMap((alias) => {
        const model = data.find((entry) => entry.id === alias);
        if (
            !model?.always_on ||
            !model.supported_features.includes("tools") ||
            !model.input_modalities.includes("text") ||
            !model.output_modalities.includes("text")
        )
            return [];
        return [
            {
                model: alias,
                isDefault: false,
                displayName: alias,
                description: model.alias_of
                    ? `Currently ${model.alias_of}. Synthetic updates this alias automatically.`
                    : "Synthetic updates this alias automatically.",
                defaultReasoningEffort: null,
                supportedReasoningEfforts: model.supported_features.includes("reasoning")
                    ? (model.reasoning_parameters?.efforts ?? []).map((effort) => ({
                          reasoningEffort: effort,
                          description: `Provider-advertised thinking level: ${effort}.`,
                      }))
                    : [],
                defaultServiceTier: null,
                serviceTiers: [],
                inputModalities: model.input_modalities.includes("image")
                    ? ["text" as const, "image" as const]
                    : ["text" as const],
            },
        ];
    });
}
