import { imageSize } from "image-size";
import * as v from "valibot";

const maximumImageBytes = 2 * 1024 * 1024;
/** Maximum aggregate UTF-8 text bytes in a single runtime tool result. */
export const maximumToolTextBytes = 256 * 1024;
const maximumBase64Length = 4 * Math.ceil(maximumImageBytes / 3);
const maximumResultBytes = 3 * 1024 * 1024;
const contentSchema = v.pipe(
    v.array(
        v.variant("type", [
            v.strictObject({
                type: v.literal("text"),
                text: v.pipe(v.string(), v.maxLength(maximumToolTextBytes)),
            }),
            v.strictObject({
                type: v.literal("image"),
                mediaType: v.picklist(["image/png", "image/jpeg"]),
                data: v.pipe(
                    v.string(),
                    v.minLength(4),
                    v.maxLength(maximumBase64Length)
                ),
            }),
        ])
    ),
    v.minLength(1),
    v.maxLength(8)
);
export type RuntimeToolResult =
    | string
    | { readonly content: v.InferOutput<typeof contentSchema> };
export type RuntimeContentItem =
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string };

/**
 * Validate host-produced tool content before forwarding it through the private runtime.
 * @param result - Existing text output or explicitly typed inline image/text content.
 * @returns Bounded protocol items; no remote URL or filesystem path is fetched.
 * @throws {Error} Content exceeds its budget or contains invalid image metadata.
 */
export function runtimeContentItems(result: unknown): RuntimeContentItem[] {
    const content =
        typeof result === "string"
            ? v.parse(contentSchema, [{ type: "text", text: result }])
            : v.parse(v.strictObject({ content: contentSchema }), result).content;
    let imageBytes = 0;
    let textBytes = 0;
    let images = 0;
    const items: RuntimeContentItem[] = content.map((item) => {
        if (item.type === "text") {
            textBytes += Buffer.byteLength(item.text);
            if (textBytes > maximumToolTextBytes)
                throw new Error("Mira tool text exceeds its limit.");
            return { type: "inputText", text: item.text };
        }
        const bytes = Buffer.from(item.data, "base64");
        imageBytes += bytes.length;
        images++;
        if (
            images > 2 ||
            imageBytes > maximumImageBytes ||
            bytes.toString("base64") !== item.data
        )
            throw new Error("Mira tool image encoding exceeds its limit or is invalid.");
        const signatureMatches =
            item.mediaType === "image/png"
                ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
                : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!signatureMatches)
            throw new Error("Mira tool image signature does not match its type.");
        const dimensions = imageSize(bytes);
        if (
            dimensions.type !== (item.mediaType === "image/png" ? "png" : "jpg") ||
            !Number.isSafeInteger(dimensions.width) ||
            !Number.isSafeInteger(dimensions.height) ||
            dimensions.width < 1 ||
            dimensions.height < 1 ||
            dimensions.width > 8192 ||
            dimensions.height > 8192 ||
            dimensions.width * dimensions.height > 16_777_216
        )
            throw new Error("Mira tool image type or dimensions are invalid.");
        return {
            type: "inputImage",
            imageUrl: `data:${item.mediaType};base64,${item.data}`,
        };
    });
    // Leave room for the JSON-RPC envelope within the transport's four-MiB bound.
    if (Buffer.byteLength(JSON.stringify(items)) > maximumResultBytes)
        throw new Error("Mira tool result exceeds its transport budget.");
    return items;
}
