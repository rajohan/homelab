import { miraComputerEffectSchema } from "@homelab/contracts/miraComputerCommands";
import { imageSize } from "image-size";
import * as v from "valibot";

import { runtimeContentItems, type RuntimeToolResult } from "../runtime/toolResult";

const observation = v.strictObject({
    observationId: v.pipe(v.string(), v.uuid()),
    width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192)),
    height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192)),
    content: v.unknown(),
});
export type ComputerCommandResult =
    | v.InferOutput<typeof miraComputerEffectSchema>
    | {
          observationId: string;
          width: number;
          height: number;
          content: Exclude<RuntimeToolResult, string>["content"];
      };

/**
 * Validate a result for its original operation before sending or consuming it.
 * @param action - Immutable operation kind from the claimed command.
 * @param input - Untrusted native/remote result, never a URL or local file reference.
 * @returns Bounded inline observation or explicit input outcome with no inferred success.
 */
export function computerCommandResult(
    action: "observe" | "click" | "type",
    input: unknown
): ComputerCommandResult {
    if (action !== "observe") return v.parse(miraComputerEffectSchema, input);
    const parsed = v.parse(observation, input);
    const items = runtimeContentItems({ content: parsed.content });
    // Native window transport carries exactly one frame, never arbitrary text instructions.
    if (items.length !== 1 || items[0]?.type !== "inputImage")
        throw new Error("Computer observation must contain exactly one image.");
    const content = parsed.content as Exclude<RuntimeToolResult, string>["content"];
    const frame = content[0]!;
    if (frame.type !== "image") throw new Error("Computer observation is invalid.");
    const dimensions = imageSize(Buffer.from(frame.data, "base64"));
    if (dimensions.width !== parsed.width || dimensions.height !== parsed.height)
        throw new Error("Computer observation dimensions changed.");
    return { ...parsed, content };
}
