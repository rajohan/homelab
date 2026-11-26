import * as v from "valibot";

export const publicBrowserScope = "public-web";
export const internetBrowserScope = "internet-web";
export const connectedBrowserScope = "connected-web";

/** Identify a temporary session that can navigate between unrelated websites.
 * @param origins - Immutable site scope selected for the grant.
 * @returns Whether the session uses a broad website scope.
 */
export function unrestrictedBrowserSites(origins: readonly string[]) {
    return (
        origins.length === 1 &&
        (origins[0] === internetBrowserScope ||
            origins[0] === publicBrowserScope ||
            origins[0] === connectedBrowserScope)
    );
}

const id = v.pipe(v.string(), v.uuid());
const address = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
export const browserAddressRejected =
    "Choose a website within this browser session’s approved scope.";
export const browserWorkspaceWarning = {
    changed: "The selected tab changed. Choose the current tab and try again.",
    limit: "Close a tab before opening another one.",
    last: "Keep one browser tab open.",
    history: "There is no permitted history entry in that direction.",
    load: "Chromium could not open that address. Check the website and its connection.",
} as const;
export const miraBrowserTabCommandSchema = v.variant("action", [
    v.strictObject({ action: v.literal("list") }),
    v.strictObject({ action: v.literal("open"), url: address }),
    v.strictObject({ action: v.literal("select"), tabId: id }),
    v.strictObject({ action: v.literal("close"), tabId: id }),
]);
export const miraBrowserWorkspaceCommandSchema = v.variant("action", [
    v.strictObject({ action: v.literal("open"), url: v.optional(address) }),
    v.strictObject({ action: v.literal("select"), tabId: id }),
    v.strictObject({ action: v.literal("close"), tabId: id }),
    v.strictObject({ action: v.literal("navigate"), tabId: id, url: address }),
    v.strictObject({ action: v.literal("back"), tabId: id }),
    v.strictObject({ action: v.literal("forward"), tabId: id }),
    v.strictObject({ action: v.literal("reload"), tabId: id }),
]);
export const miraBrowserTabsSchema = v.strictObject({
    selectedId: id,
    canGoBack: v.optional(v.boolean()),
    canGoForward: v.optional(v.boolean()),
    warning: v.optional(v.picklist(Object.values(browserWorkspaceWarning))),
    items: v.pipe(
        v.array(
            v.strictObject({
                id,
                url: v.nullable(address),
                title: v.pipe(v.string(), v.maxLength(2048)),
            })
        ),
        v.minLength(1),
        v.maxLength(8)
    ),
});
export type MiraBrowserTabs = v.InferOutput<typeof miraBrowserTabsSchema>;
export const miraBrowserProfileDeleteSchema = v.strictObject({ id });
export interface MiraBrowserProfile {
    homeNetwork?: boolean;
    id: string;
    name: string;
    origins: string[];
    state: "active" | "deleting";
    busy: boolean;
    createdAt: string;
}
export const miraBrowserAccessStopSchema = v.strictObject({ id });
export const miraBrowserAccessListSchema = v.optional(v.strictObject({ runId: id }));
export interface MiraBrowserAccessSummary {
    id: string;
    runId: string;
    mode: "view" | "control";
    state: "pending" | "active" | "stopping" | "closed" | "unavailable";
    expiresAt: string | null;
    origins: string[];
    initialUrl: string | null;
}

const ref = v.pipe(v.string(), v.regex(/^p[0-9]{1,16}:[0-9]{1,6}$/));
export const miraBrowserKeys = [
    "BackSpace",
    "Tab",
    "Return",
    "Escape",
    "space",
    "Delete",
    "Home",
    "End",
    "Left",
    "Right",
    "Up",
    "Down",
    "Page_Up",
    "Page_Down",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
] as const;
export const miraBrowserModifiers = ["ctrl", "alt", "shift", "super"] as const;
const coordinate = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8191));
const delta = v.pipe(v.number(), v.integer(), v.minValue(-2400), v.maxValue(2400));
export const miraBrowserActionSchema = v.variant("action", [
    v.strictObject({
        action: v.literal("click_at"),
        observationId: id,
        x: coordinate,
        y: coordinate,
        button: v.optional(v.picklist(["left", "middle", "right"]), "left"),
        count: v.optional(v.picklist([1, 2]), 1),
    }),
    v.strictObject({
        action: v.literal("move"),
        observationId: id,
        x: coordinate,
        y: coordinate,
    }),
    v.strictObject({
        action: v.literal("drag"),
        observationId: id,
        x: coordinate,
        y: coordinate,
        toX: coordinate,
        toY: coordinate,
    }),
    v.strictObject({
        action: v.literal("scroll"),
        observationId: id,
        x: coordinate,
        y: coordinate,
        deltaX: delta,
        deltaY: delta,
    }),
    v.strictObject({
        action: v.literal("key"),
        observationId: id,
        key: v.picklist(miraBrowserKeys),
        modifiers: v.optional(
            v.pipe(v.array(v.picklist(miraBrowserModifiers)), v.maxLength(4)),
            []
        ),
    }),
    v.strictObject({
        action: v.literal("type_text"),
        observationId: id,
        text: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(4000),
            v.check((text) => text.isWellFormed() && !text.includes("\0"))
        ),
    }),

    v.strictObject({ action: v.literal("click"), observationId: id, ref }),
    v.strictObject({
        action: v.literal("type"),
        observationId: id,
        ref,
        text: v.pipe(
            v.string(),
            v.maxLength(4000),
            v.check((text) => text.isWellFormed() && !text.includes("\0"))
        ),
        replace: v.boolean(),
    }),
]);
export const miraBrowserConsoleSchema = v.strictObject({ id });
export const miraBrowserAttachSchema = v.strictObject({ id, epoch: id, fileId: id });
export const miraBrowserTransferSchema = v.strictObject({
    id,
    epoch: id,
    controller: v.picklist(["mira", "human"]),
});
export const miraBrowserUploadFileSchema = v.strictObject({
    id,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25 * 1024 * 1024)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export type MiraBrowserUploadFile = v.InferOutput<typeof miraBrowserUploadFileSchema>;
export const miraBrowserDownloadNameSchema = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(200),
    v.check((name) => name.isWellFormed() && !/[\p{Cc}/\\]/u.test(name))
);
export const miraBrowserFileRequestSchema = v.strictObject({
    id,
    kind: v.picklist(["upload", "download"]),
    observationId: id,
    ref,
    origin: address,
    label: v.pipe(v.string(), v.maxLength(256)),
    suggestedName: v.nullable(miraBrowserDownloadNameSchema),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type MiraBrowserFileRequest = v.InferOutput<typeof miraBrowserFileRequestSchema>;
export const miraBrowserHumanOperationSchema = v.variant("method", [
    v.strictObject({ method: v.literal("observe") }),
    v.strictObject({
        method: v.literal("tabs"),
        input: miraBrowserWorkspaceCommandSchema,
    }),
    v.strictObject({
        method: v.literal("download"),
        input: v.strictObject({ observationId: id, ref }),
        origin: address,
        name: miraBrowserDownloadNameSchema,
    }),
    v.strictObject({
        method: v.literal("upload"),
        input: v.strictObject({ observationId: id, ref }),
        origin: address,
        file: miraBrowserUploadFileSchema,
    }),
]);
export const miraBrowserHumanCommandSchema = v.strictObject({
    id,
    epoch: id,
    commandId: id,
    operation: miraBrowserHumanOperationSchema,
});
export interface MiraBrowserPreview {
    observationId: string;
    url: string;
    title: string;
    refs: {
        ref: string;
        role: string;
        label: string;
        actions: ("click" | "type" | "upload")[];
    }[];
    observedAt: string;
}
export interface MiraBrowserConsole {
    fileRequest?: MiraBrowserFileRequest | null;
    tabs: MiraBrowserTabs | null;
    epoch: string;
    controller: "mira" | "human";
    busy: boolean;
    preview: MiraBrowserPreview | null;
}
