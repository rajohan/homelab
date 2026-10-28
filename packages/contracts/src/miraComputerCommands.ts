import * as v from "valibot";

const id = v.pipe(v.string(), v.uuid());
export const miraComputerCommandBindingSchema = v.strictObject({
    accessId: id,
    connectionId: id,
    targetId: id,
});
export const miraComputerInputSchema = v.variant("action", [
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
