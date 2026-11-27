import * as v from "valibot";

import { tableCursorSchema, tableSortSchema } from "./tableSort";

const text = (maximum: number) =>
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maximum));
export const updateItemSchema = v.strictObject({
    id: text(200),
    name: text(200),
    kind: v.picklist(["os", "runtime", "application", "container"]),
    installed: text(200),
    available: v.nullable(text(200)),
    status: v.picklist(["current", "available", "unknown"]),
    security: v.optional(v.boolean(), false),
    held: v.optional(v.boolean(), false),
    release: v.optional(
        v.picklist([
            "bun",
            "node",
            "openclaw",
            "github-cli",
            "adguard-home",
            "adguardhome-sync",
            "node-exporter",
            "smartctl-exporter",
            "blackbox-exporter",
            "alertmanager",
            "victoriametrics",
            "alloy",
            "loki",
            "traefik",
            "pve-exporter",
            "pgadmin",
            "nextcloud",
            "code-server",
            "codex",
        ])
    ),
    image: v.optional(text(300)),
    pinned: v.optional(v.boolean()),
    availableImage: v.optional(text(300)),
    installedVersion: v.optional(text(100)),
    availableVersion: v.optional(text(100)),
    digestOnly: v.optional(v.boolean()),
    candidateVerified: v.optional(v.boolean()),
    imageTag: v.optional(
        v.pipe(v.string(), v.regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/))
    ),
    platform: v.optional(
        v.strictObject({
            os: text(32),
            architecture: text(32),
            variant: v.optional(text(32)),
        })
    ),
});
export const updateReportSchema = v.strictObject({
    capturedAt: v.pipe(v.string(), v.isoTimestamp()),
    rebootRequired: v.optional(v.nullable(v.boolean())),
    rebootObservedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    repositoryMetadataAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
    aptObservedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    complete: v.boolean(),
    coveredKinds: v.pipe(
        v.array(v.picklist(["os", "runtime", "application", "container"])),
        v.minLength(1),
        v.maxLength(4)
    ),
    items: v.pipe(v.array(updateItemSchema), v.maxLength(5000)),
});
export type UpdateItem = v.InferOutput<typeof updateItemSchema>;
export type UpdateReport = v.InferOutput<typeof updateReportSchema>;
export const updateListSchema = v.strictObject({
    category: v.optional(v.picklist(["all", "software", "toolchains"]), "all"),
    sort: v.optional(
        tableSortSchema(["name", "kind", "installed", "available", "status"])
    ),
    cursor: v.optional(tableCursorSchema),
    source: text(100),
    search: v.optional(v.pipe(v.string(), v.maxLength(160)), ""),
    state: v.optional(v.picklist(["attention", "all"]), "attention"),
    after: v.optional(text(200)),
    limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        50
    ),
});
export interface UpdateSource {
    readonly id: string;
    readonly label: string;
    readonly publisher: string;
}
export interface UpdateSourceStatus {
    readonly id: string;
    readonly label: string;
    readonly stale: boolean;
    readonly restart?: {
        readonly required: boolean | null;
        readonly observedAt: string;
        readonly stale: boolean;
    } | null;
    readonly report:
        | (Omit<UpdateReport, "items"> & {
              readonly available: number;
              readonly security: number;
              readonly total: number;
          })
        | null;
}

export const updateRequestSchema = v.strictObject({
    target: text(64),
    item: text(200),
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    requestId: v.pipe(v.string(), v.uuid()),
});
export const updateBatchScopeSchema = v.strictObject({
    source: v.optional(text(100)),
});
export const updateBatchRequestSchema = v.strictObject({
    ...updateBatchScopeSchema.entries,
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    requestId: v.pipe(v.string(), v.uuid()),
    items: v.optional(
        v.pipe(
            v.array(v.strictObject({ source: text(100), item: text(200) })),
            v.minLength(1),
            v.maxLength(5000)
        )
    ),
});
export interface UpdateBatchEntry {
    readonly source: string;
    readonly sourceLabel: string;
    readonly item: UpdateItem;
    readonly control: UpdateControl | null;
    readonly reason: string | null;
}
export interface UpdateBatchPlan {
    readonly revision: string;
    readonly entries: readonly UpdateBatchEntry[];
    readonly eligible: number;
    readonly excluded: number;
    readonly hosts: number;
}
export const updatePolicySchema = v.strictObject({
    target: text(64),
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    enabled: v.boolean(),
    allowDigest: v.optional(v.boolean()),
});
export const updatePolicyGroupSchema = v.strictObject({
    host: v.nullable(v.pipe(v.string(), v.regex(/^host:[a-f0-9]{64}$/))),
    enabled: v.boolean(),
    expected: v.pipe(
        v.array(
            v.strictObject({
                target: updatePolicySchema.entries.target,
                version: updatePolicySchema.entries.version,
                revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
            })
        ),
        v.minLength(1),
        v.maxLength(100)
    ),
});
export type UpdatePolicyGroupInput = v.InferOutput<typeof updatePolicyGroupSchema>;
export type UpdateChange = "patch" | "minor" | "major" | "digest" | "unknown";
export interface UpdateControl {
    readonly target: string;
    readonly revision: string;
    readonly change: UpdateChange;
    readonly allowed: boolean;
    readonly reason: string | null;
}
export interface UpdatePolicy {
    readonly host: string;
    readonly revision: string;
    readonly category?: "software" | "toolchains";
    readonly target: string;
    readonly label: string;
    readonly source: string;
    readonly enabled: boolean;
    readonly version: number;
    readonly configurationChanged: boolean;
    readonly allowDigest?: boolean;
}

/**
 * Decide which targets a confirmed group change will write, including old consent.
 * @param policy - Effective policy and whether its stored recipe has changed.
 * @param enabled - Requested state for the current recipe.
 * @returns Whether the target must be listed for confirmation and saved.
 */
export function updatePolicyNeedsChange(policy: UpdatePolicy, enabled: boolean): boolean {
    return policy.configurationChanged || policy.enabled !== enabled;
}

function versionParts(value: string | undefined, debian: boolean): number[] | null {
    if (!value) return null;
    const normalized = debian
        ? value.replace(/^\d+:/, "").replace(/-\d[^-]*$/, "")
        : value;
    const match = /^(?:v)?(\d+)\.(\d+)(?:\.(\d+))?(?:\+[a-zA-Z0-9.]+)?$/.exec(normalized);
    if (!match) return null;
    const numbers = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    return numbers.every((number) => Number.isSafeInteger(number)) ? numbers : null;
}

function imageVersion(reference: string | undefined): string | undefined {
    const unpinned = reference?.split("@")[0];
    const tag = unpinned?.slice(unpinned.lastIndexOf(":") + 1);
    return tag?.replace(/-(?:alpine|bookworm|bullseye|trixie|slim)[\d.-]*$/, "");
}

function tzRelease(version: string) {
    return /^(?:(\d+):)?(\d{4})(z*[a-z])(?:-[0-9][A-Za-z0-9.+]*)?$/.exec(version);
}

// Compare the final numeric build only within the same epoch, numeric upstream
// version and packaging series. A ~bpo suffix is a Debian backport series.
const aptRevisionSeries =
    /^((?:\d+:)?\d+(?:\.\d+)*-(?=\d)(?:[A-Za-z0-9.+]|~bpo)*?)(\d+)$/;

/**
 * Classify comparable stable versions without assuming an opaque tag is a safe update.
 * @param item - Installed and resolved candidate metadata; digests are never versions.
 * @returns Patch/minor/major, or unknown for downgrade, prerelease or unversioned channels.
 */
export function updateChange(item: UpdateItem): UpdateChange {
    if (item.kind === "os" && /^apt:tzdata(?::[a-z0-9]+)?$/.test(item.id)) {
        const from = tzRelease(item.installed);
        const to = tzRelease(item.available ?? "");
        if (!from || !to || from[1] !== to[1]) return "unknown";
        return to[2]! + to[3]! > from[2]! + from[3]! ? "patch" : "unknown";
    }
    if (item.kind === "container" && item.digestOnly && item.candidateVerified)
        return "digest";
    const installedLabel = item.installedVersion ?? imageVersion(item.image);
    const availableLabel = item.availableVersion ?? imageVersion(item.availableImage);
    const installed = versionParts(
        item.kind === "container"
            ? installedLabel?.replace(/-ls\d+$/, "")
            : item.installed,
        item.kind === "os"
    );
    const available = versionParts(
        item.kind === "container"
            ? availableLabel?.replace(/-ls\d+$/, "")
            : (item.available ?? undefined),
        item.kind === "os"
    );
    if (!installed || !available) {
        if (item.kind === "os" && item.status === "available" && item.available) {
            const from = aptRevisionSeries.exec(item.installed);
            const to = aptRevisionSeries.exec(item.available);
            if (from && to && from[1] === to[1] && BigInt(to[2]!) > BigInt(from[2]!))
                return "patch";
        }
        return "unknown";
    }
    for (let index = 0; index < 3; index += 1) {
        const before = installed[index]!;
        const after = available[index]!;
        if (after < before) return "unknown";
        if (after > before) {
            if (index === 0) return "major";
            return index === 1 ? "minor" : "patch";
        }
    }
    if (item.kind === "container") {
        const from = /-ls(\d+)$/.exec(installedLabel ?? "");
        const to = /-ls(\d+)$/.exec(availableLabel ?? "");
        if ((from || to) && (!from || !to || BigInt(to[1]!) < BigInt(from[1]!)))
            return "unknown";
    }
    return "patch";
}
