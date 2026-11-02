import path from "node:path";

import * as v from "valibot";

import miraPackage from "../../../package.json";

export const computerDriverVersion = miraPackage.dependencies["@trycua/cua-driver"];
const grantSchema = v.strictObject({
    scope: v.exactOptional(v.literal("window")),
    executable: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    pid: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_647)),
    windowId: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,19}$/)),
    startedAt: v.optional(v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,19}$/))),
    delivery: v.picklist(["background", "foreground"]),
    mode: v.optional(v.picklist(["view", "control"])),
});
export type ComputerWindowGrant = v.InferOutput<typeof grantSchema>;
const desktopGrantSchema = v.strictObject({
    scope: v.literal("desktop"),
    displayId: v.literal("primary"),
    delivery: v.literal("foreground"),
    mode: v.optional(v.picklist(["view", "control"])),
});
export type ComputerGrant =
    | ComputerWindowGrant
    | v.InferOutput<typeof desktopGrantSchema>;

/**
 * Validate the immutable target selected by the local consent host.
 * @param input - Exact window identity or explicit primary-desktop consent, never model arguments.
 * @returns A window or desktop grant without silently widening its scope.
 */
export function computerGrant(input: unknown): ComputerGrant {
    const parsed = v.parse(v.union([grantSchema, desktopGrantSchema]), input);
    return parsed.scope === "desktop" ? parsed : computerWindowGrant(parsed);
}

/**
 * Validate a trusted host's exact window grant; paths must already be resolved by that host.
 * @param input - Local host configuration, never accepted directly from model tool arguments.
 * @returns A bounded native window identity and explicit input delivery mode.
 */
export function computerWindowGrant(input: unknown): ComputerWindowGrant {
    const grant = v.parse(grantSchema, input);
    if (
        !path.isAbsolute(grant.executable) ||
        BigInt(grant.windowId) > BigInt(Number.MAX_SAFE_INTEGER)
    )
        throw new Error(
            "Computer grant must name an absolute executable and native window."
        );
    return grant;
}

/**
 * Construct the driver's immutable deny-by-default permission ceiling for one application.
 * @param input - Trusted host grant; the adapter further binds every call to its PID/window.
 * @returns A v3 capability manifest with five-minute total and one-minute idle lifetimes.
 */
export function computerWindowManifest(input: unknown) {
    const grant = computerWindowGrant(input);
    return {
        version: 3,
        expires_after: "5m",
        idle_timeout: "1m",
        allow: {
            tools:
                grant.mode === "view"
                    ? ["get_window_state"]
                    : ["get_window_state", "click", "type_text"],
        },
        resources: {
            apps: [{ executable: grant.executable, windows: "all" }],
            desktop: { display: false },
        },
    };
}

/**
 * Build the fixed driver ceiling for the locally approved target and input mode.
 * @param input - Validated local window or primary-desktop grant.
 * @returns A bounded v3 manifest; desktop access never grants process or clipboard tools.
 */
export function computerManifest(input: unknown) {
    const grant = computerGrant(input);
    if (grant.scope !== "desktop") return computerWindowManifest(grant);
    return {
        version: 3,
        expires_after: "5m",
        idle_timeout: "1m",
        allow: {
            tools:
                grant.mode === "view"
                    ? ["get_desktop_state"]
                    : ["get_desktop_state", "click", "type_text"],
        },
        resources: { apps: [], desktop: { display: true } },
    };
}
