import * as v from "valibot";

const id = v.pipe(v.string(), v.uuid());
export const miraComputerCommandBindingSchema = v.strictObject({
    accessId: id,
    connectionId: id,
    targetId: id,
});
export const miraComputerElementTokenSchema = v.pipe(
    v.string(),
    v.maxLength(32),
    v.regex(/^s[0-9a-f]{8}:[0-9]+$/)
);
export const miraComputerElementsSchema = v.pipe(
    v.array(
        v.strictObject({
            token: miraComputerElementTokenSchema,
            role: v.pipe(v.string(), v.maxLength(64)),
            label: v.pipe(v.string(), v.maxLength(128)),
        })
    ),
    v.maxLength(200),
    v.check((items) => new Set(items.map((item) => item.token)).size === items.length)
);
export const miraComputerObservationTargetsSchema = v.strictObject({
    elements: v.optional(miraComputerElementsSchema),
    coordinateInput: v.optional(v.boolean()),
});
export type MiraComputerElement = v.InferOutput<
    typeof miraComputerElementsSchema
>[number];
export const miraComputerInputSchema = v.variant("action", [
    v.strictObject({
        action: v.literal("click_element"),
        observationId: id,
        elementToken: miraComputerElementTokenSchema,
    }),
    v.strictObject({
        action: v.literal("click"),
        observationId: id,
        x: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8191)),
        y: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8191)),
    }),
    v.strictObject({
        action: v.literal("type"),
        observationId: id,
        text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    }),
]);
export const miraComputerOperationSchema = v.variant("action", [
    v.strictObject({ action: v.literal("observe") }),
    ...miraComputerInputSchema.options,
]);
export const miraComputerCommandSchema = v.strictObject({
    ...miraComputerCommandBindingSchema.entries,
    commandId: id,
    validForMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)),
    operation: miraComputerOperationSchema,
});
export const miraComputerEffectSchema = v.strictObject({
    effect: v.picklist(["confirmed", "partial", "unverified", "refused", "unknown"]),
});
export type MiraComputerCommandBinding = v.InferOutput<
    typeof miraComputerCommandBindingSchema
>;
export type MiraComputerCommand = v.InferOutput<typeof miraComputerCommandSchema>;
