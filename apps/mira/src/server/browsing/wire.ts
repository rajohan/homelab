import { imageSize } from "image-size";
import * as v from "valibot";

import { runtimeContentItems } from "../runtime/toolResult";
import { browserGrant, browserUrl } from "./policy";

export const browserWorkerExecutable = "/usr/lib/chromium/chromium";
const address = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
const grantSchema = v.strictObject({
    origins: v.pipe(v.array(address), v.minLength(1), v.maxLength(16)),
    initialUrl: address,
    mode: v.picklist(["view", "control"]),
});
const ref = v.pipe(v.string(), v.regex(/^p[0-9]{1,16}:[0-9]{1,6}$/));
const observationId = v.pipe(v.string(), v.uuid());
export const browserActionSchema = v.variant("action", [
    v.strictObject({ action: v.literal("click"), observationId, ref }),
    v.strictObject({
        action: v.literal("type"),
        observationId,
        ref,
        text: v.pipe(
            v.string(),
            v.maxLength(4000),
            v.check((text) => text.isWellFormed() && !text.includes("\0"))
        ),
        replace: v.boolean(),
    }),
]);
export const browserWorkerRequestSchema = v.strictObject({
    id: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(Number.MAX_SAFE_INTEGER)
    ),
    body: v.variant("method", [
        v.strictObject({ method: v.literal("initialize"), params: grantSchema }),
        v.strictObject({ method: v.literal("observe"), params: v.strictObject({}) }),
        v.strictObject({
            method: v.literal("navigate"),
            params: v.strictObject({ url: address }),
        }),
        v.strictObject({ method: v.literal("act"), params: browserActionSchema }),
    ]),
});
const bounded = (limit: number) => v.pipe(v.string(), v.maxLength(limit));
const dimension = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192));
const actionsSchema = v.pipe(
    v.array(v.picklist(["click", "type"])),
    v.minLength(1),
    v.maxLength(2)
);
const frameSchema = v.strictObject({
    observationId,
    url: address,
    title: bounded(2048),
    outline: bounded(64 * 1024),
    complete: v.boolean(),
    refs: v.pipe(
        v.array(
            v.strictObject({
                ref,
                role: bounded(64),
                label: bounded(256),
                actions: actionsSchema,
            })
        ),
        v.maxLength(300)
    ),
    width: dimension,
    height: dimension,
    content: v.strictObject({
        content: v.pipe(
            v.array(
                v.strictObject({
                    type: v.literal("image"),
                    mediaType: v.literal("image/png"),
                    data: bounded(3 * 1024 * 1024),
                })
            ),
            v.length(1)
        ),
    }),
});

/**
 * Validate host-owned origins and access mode while fixing the executable inside the image.
 * @param input - Trusted policy; executable, profile, target and launch options are refused.
 * @returns An independent wire grant containing only origins, initial URL and access mode.
 */
export function browserWorkerGrant(input: unknown) {
    const grant = v.parse(grantSchema, input);
    browserGrant({ ...grant, executable: browserWorkerExecutable });
    return grant;
}

/**
 * Validate an untrusted worker observation before exposing text, refs or pixels to the caller.
 * @param input - Exactly one worker result, without native target IDs or diagnostics.
 * @param origins - The immutable host-approved origin ceiling for this connection.
 * @returns A bounded PNG observation with unique actionable refs and matching dimensions.
 */
export function browserWorkerFrame(input: unknown, origins: readonly string[]) {
    const frame = v.parse(frameSchema, input);
    browserUrl(frame.url, origins);
    runtimeContentItems(frame.content);
    const dimensions = imageSize(Buffer.from(frame.content.content[0]!.data, "base64"));
    if (
        dimensions.width !== frame.width ||
        dimensions.height !== frame.height ||
        new Set(frame.refs.map((item) => item.ref)).size !== frame.refs.length ||
        new Set(frame.refs.map((item) => item.ref.split(":")[0])).size > 1 ||
        frame.refs.some((item) => new Set(item.actions).size !== item.actions.length)
    )
        throw new Error("Invalid browser observation identity or image.");
    return frame;
}
