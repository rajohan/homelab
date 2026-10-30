import { imageSize } from "image-size";
import * as v from "valibot";

import { runtimeContentItems } from "../runtime/toolResult";
import { browserUrl } from "./policy";

const bounded = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const positive = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16_384));
const opaque = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
export const bindingSchema = v.object({
    status: v.literal("ok"),
    mode: v.literal("bind"),
    binding_quality: v.literal("exact"),
    endpoint_access_class: v.literal("driver_owned"),
    mutation_allowed: v.literal(true),
    target_id: opaque,
    tabs: v.pipe(
        v.array(v.object({ tab_id: opaque, url: v.literal("about:blank") })),
        v.length(1)
    ),
});
export const preparedSchema = v.object({
    status: v.literal("ok"),
    prepared: v.literal(true),
    action: v.literal("launched_isolated_browser"),
    prepared_pid: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(2_147_483_647)
    ),
    endpoint_ownership: v.object({
        method: v.literal("spawned_by_driver"),
        owner_pid: v.number(),
    }),
    lifecycle: v.object({
        owner: v.literal("session"),
        process_ends_with_session: v.literal(true),
        profile_persists_after_session: v.boolean(),
    }),
});
export const windowsSchema = v.object({
    windows: v.pipe(
        v.array(
            v.object({
                pid: v.number(),
                window_id: v.pipe(
                    v.number(),
                    v.integer(),
                    v.minValue(1),
                    v.maxValue(Number.MAX_SAFE_INTEGER)
                ),
            })
        ),
        v.length(1)
    ),
});
const referenceSchema = v.object({
    ref: v.pipe(v.string(), v.regex(/^p[0-9]{1,16}:[0-9]{1,6}$/)),
    role: bounded(256),
    name: v.nullable(bounded(4096)),
    actions: v.pipe(v.array(bounded(32)), v.maxLength(16)),
    frame: bounded(32),
    visibility: bounded(32),
    states: v.object({ disabled: v.optional(v.boolean()) }),
});
const snapshotSchema = v.object({
    status: v.literal("ok"),
    mode: v.literal("snapshot"),
    target_id: opaque,
    tab_id: opaque,
    page: v.object({ url: bounded(2048), title: bounded(2048) }),
    snapshot: v.object({
        id: v.pipe(v.string(), v.regex(/^p[0-9]{1,16}$/)),
        format: v.literal("semantic_v2"),
        complete: v.boolean(),
    }),
    outline: bounded(64 * 1024),
    refs: v.pipe(v.array(referenceSchema), v.maxLength(300)),
    screenshot: v.object({
        source: v.literal("cdp_tab"),
        scope: v.literal("viewport"),
        mime_type: v.literal("image/png"),
        width: positive,
        height: positive,
    }),
});
export interface BrowserNativeResult {
    isError: boolean;
    structuredJson?: string;
    images: { mimeType: string; dataBase64: string }[];
}

/**
 * Read bounded native metadata without forwarding driver diagnostics or arbitrary instructions.
 * @param result - One fixed SDK tool response.
 * @returns Untrusted JSON for operation-specific schema validation.
 */
export function browserMetadata(result: BrowserNativeResult): unknown {
    if (
        result.isError ||
        !result.structuredJson ||
        Buffer.byteLength(result.structuredJson) > 256 * 1024
    )
        throw new Error(
            "The browser operation was refused or returned invalid metadata."
        );
    return JSON.parse(result.structuredJson) as unknown;
}

/**
 * Validate a tab-only frame and expose only visible main-document action references.
 * @param result - Native semantic snapshot and its inline viewport image.
 * @param target - The immutable internally selected tab and origin ceiling.
 * @returns Bounded untrusted page content with no generic native or CDP handles.
 */
export function browserSnapshot(
    result: BrowserNativeResult,
    target: { targetId: string; tabId: string; origins: readonly string[] }
) {
    const data = v.parse(snapshotSchema, browserMetadata(result));
    if (
        data.target_id !== target.targetId ||
        data.tab_id !== target.tabId ||
        result.images.length !== 1
    )
        throw new Error("The browser snapshot does not match the selected tab.");
    const url = browserUrl(data.page.url, target.origins);
    const image = result.images[0]!;
    if (image.mimeType !== "image/png") throw new Error("The browser frame must be PNG.");
    const content = {
        content: [
            {
                type: "image" as const,
                mediaType: "image/png" as const,
                data: image.dataBase64,
            },
        ],
    };
    runtimeContentItems(content);
    const dimensions = imageSize(Buffer.from(image.dataBase64, "base64"));
    if (
        dimensions.width !== data.screenshot.width ||
        dimensions.height !== data.screenshot.height
    )
        throw new Error("The browser frame dimensions do not match.");
    const refs = data.refs
        .filter(
            (item) =>
                item.frame === "main" &&
                item.visibility === "in_viewport" &&
                item.states.disabled !== true
        )
        .map((item) => ({
            ref: item.ref,
            role: item.role.slice(0, 64),
            label: (item.name ?? "").slice(0, 256),
            actions: item.actions.filter(
                (action): action is "click" | "type" =>
                    action === "click" || action === "type"
            ),
        }))
        .filter((item) => item.actions.length > 0);
    if (
        new Set(refs.map((item) => item.ref)).size !== refs.length ||
        refs.some((item) => !item.ref.startsWith(`${data.snapshot.id}:`))
    )
        throw new Error("The browser returned ambiguous or stale references.");
    return {
        url,
        title: data.page.title,
        outline: data.outline,
        complete: data.snapshot.complete,
        refs,
        width: dimensions.width,
        height: dimensions.height,
        content,
    };
}
