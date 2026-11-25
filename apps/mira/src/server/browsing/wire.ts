export const browserDriverVersion = "chromium-live-3";
import {
    miraBrowserActionSchema,
    miraBrowserFileRequestSchema,
    miraBrowserTabCommandSchema,
    miraBrowserTabsSchema,
    miraBrowserWorkspaceCommandSchema,
} from "@homelab/contracts/miraBrowser";
import { browserClipboardCommandSchema } from "@homelab/contracts/miraBrowserClipboard";
import { imageSize } from "image-size";
import * as v from "valibot";

import { runtimeContentItems } from "../runtime/toolResult";
import { browserDownloadOffsetSchema } from "./downloadTransfer";
import { browserGrant, browserUrl } from "./policy";
import { browserProfilePartSchema } from "./profileTransfer";
import { browserUploadActionSchema } from "./upload";
import { browserUploadHeaderSchema, browserUploadPartSchema } from "./uploadTransfer";

export const browserWorkerExecutable = "/usr/lib/chromium/chromium";
const address = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
const grantSchema = v.strictObject({
    origins: v.pipe(v.array(address), v.minLength(1), v.maxLength(16)),
    initialUrl: address,
    mode: v.picklist(["view", "control"]),
    uploads: v.optional(v.literal(true)),
    downloads: v.optional(v.literal(true)),
});
const ref = v.pipe(v.string(), v.regex(/^p[0-9]{1,16}:[0-9]{1,6}$/));
const observationId = v.pipe(v.string(), v.uuid());
export const browserActionSchema = miraBrowserActionSchema;
export const browserWorkerRequestSchema = v.strictObject({
    id: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(Number.MAX_SAFE_INTEGER)
    ),
    body: v.variant("method", [
        v.strictObject({
            method: v.literal("clipboard"),
            params: browserClipboardCommandSchema,
        }),
        v.strictObject({
            method: v.literal("profile"),
            params: browserProfilePartSchema,
        }),
        v.strictObject({ method: v.literal("initialize"), params: grantSchema }),
        v.strictObject({
            method: v.literal("fileGesture"),
            params: v.strictObject({ epoch: v.nullable(observationId) }),
        }),
        v.strictObject({
            method: v.literal("workspace"),
            params: v.strictObject({
                input: v.optional(miraBrowserWorkspaceCommandSchema),
            }),
        }),
        v.strictObject({
            method: v.literal("observe"),
            params: v.strictObject({ operator: v.optional(v.boolean()) }),
        }),
        v.strictObject({
            method: v.literal("tabs"),
            params: v.strictObject({
                input: v.union([
                    miraBrowserTabCommandSchema,
                    miraBrowserWorkspaceCommandSchema,
                ]),
                operator: v.optional(v.boolean()),
            }),
        }),
        v.strictObject({
            method: v.literal("navigate"),
            params: v.strictObject({ url: address }),
        }),
        v.strictObject({ method: v.literal("act"), params: browserActionSchema }),
        v.strictObject({
            method: v.literal("uploadBegin"),
            params: browserUploadHeaderSchema,
        }),
        v.strictObject({
            method: v.literal("uploadPart"),
            params: browserUploadPartSchema,
        }),
        v.strictObject({ method: v.literal("uploadFinish"), params: v.strictObject({}) }),
        v.strictObject({
            method: v.literal("downloadBegin"),
            params: browserUploadActionSchema,
        }),
        v.strictObject({
            method: v.literal("downloadPart"),
            params: browserDownloadOffsetSchema,
        }),
        v.strictObject({
            method: v.literal("downloadFinish"),
            params: v.strictObject({}),
        }),
    ]),
});
const bounded = (limit: number) => v.pipe(v.string(), v.maxLength(limit));
const dimension = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192));
const actionsSchema = v.pipe(
    v.array(v.picklist(["click", "type", "upload"])),
    v.minLength(1),
    v.maxLength(3)
);
const frameSchema = v.strictObject({
    tabs: v.optional(miraBrowserTabsSchema),
    observationId,
    url: v.nullable(address),
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
                    mediaType: v.picklist(["image/png", "image/jpeg"]),
                    data: bounded(3 * 1024 * 1024),
                })
            ),
            v.length(1)
        ),
    }),
});

/** Metadata for operator file controls; live display pixels are never persisted here. */
export const browserPreviewSchema = v.object({
    ...v.pick(frameSchema, ["observationId", "url", "title", "refs"]).entries,
    fileRequest: v.optional(miraBrowserFileRequestSchema),
});
export const browserGestureResultSchema = v.union([
    v.null(),
    v.strictObject({ cleared: observationId }),
    v.strictObject({
        ...browserPreviewSchema.entries,
        fileRequest: miraBrowserFileRequestSchema,
    }),
]);

/** Validate the single target of an operator gesture against the original site grant.
 * @param input - Private, bounded worker result; null means no change.
 * @param grant - Immutable file permissions and sites held by the host.
 * @returns A targeted preview, a stale request ID to clear, or no change.
 */
export function browserGestureResult(
    input: unknown,
    grant: {
        origins: readonly string[];
        uploads?: boolean | undefined;
        downloads?: boolean | undefined;
    }
) {
    const result = v.parse(browserGestureResultSchema, input);
    if (!result || "cleared" in result) return result;
    const request = result.fileRequest;
    const [target] = result.refs;
    const lifetime = Date.parse(request.expiresAt) - Date.now();
    if (
        !result.url ||
        new URL(browserUrl(result.url, grant.origins)).origin !== request.origin ||
        result.observationId !== request.observationId ||
        result.refs.length !== 1 ||
        target?.ref !== request.ref ||
        target.label !== request.label ||
        lifetime > 61_000 ||
        target.actions.length !== 1 ||
        (request.kind === "upload"
            ? !grant.uploads || target.actions[0] !== "upload"
            : !grant.downloads || target.role !== "link" || target.actions[0] !== "click")
    )
        throw new Error("Invalid browser file request.");
    return result;
}

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

/** Check the active tab and all visible site metadata against the original grant.
 * @param input - Metadata from the Chromium worker without page pixels or references.
 * @param origins - Approved sites retained by the host.
 * @returns The bounded, uniquely identified tab strip.
 */
export function browserWorkerTabs(input: unknown, origins: readonly string[]) {
    const tabs = v.parse(miraBrowserTabsSchema, input);
    const ids = new Set(tabs.items.map((tab) => tab.id));
    if (ids.size !== tabs.items.length || !ids.has(tabs.selectedId))
        throw new Error("Invalid browser tab inventory.");
    for (const tab of tabs.items) {
        if (tab.url === null) tab.title = "";
        else browserUrl(tab.url, origins);
    }
    return tabs;
}

/**
 * Validate an untrusted worker observation before exposing text, refs or pixels to the caller.
 * @param input - Exactly one worker result, without native target IDs or diagnostics.
 * @param origins - The immutable host-approved origin ceiling for this connection.
 * @returns A bounded image observation with unique actionable refs and matching dimensions.
 */
export function browserWorkerFrame(input: unknown, origins: readonly string[]) {
    const frame = v.parse(frameSchema, input);
    if (frame.url !== null) browserUrl(frame.url, origins);
    else if (frame.refs.length > 0)
        throw new Error("Non-website observations cannot contain page refs.");
    if (frame.tabs) {
        const { items, selectedId } = (frame.tabs = browserWorkerTabs(
            frame.tabs,
            origins
        ));
        if (items.find((tab) => tab.id === selectedId)?.url !== frame.url)
            throw new Error("Invalid browser tab inventory.");
    }
    if (frame.url === null) frame.title = "";
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
