import * as v from "valibot";

import type { BrowserDockerRequest } from "./docker";

export const browserProfileSchema = v.strictObject({ id: v.pipe(v.string(), v.uuid()) });
export type BrowserProfile = v.InferOutput<typeof browserProfileSchema>;
export const browserProfileDirectory = "/var/lib/mira-browser-profile";
const label = "io.homelab.mira.browser-profile";

/**
 * Resolve a trusted registry identity without accepting arbitrary paths.
 * @returns Its fixed Docker volume name.
 */
export function browserProfileVolume(input: BrowserProfile) {
    return `mira-browser-profile-${v.parse(browserProfileSchema, input).id}`;
}

/**
 * Inspect one local, option-free volume and prove its exact registry label before use or deletion.
 * @returns False for an absent volume; mismatched ownership or driver configuration always rejects.
 */
export async function inspectBrowserProfile(
    call: BrowserDockerRequest,
    profile: BrowserProfile
) {
    const name = browserProfileVolume(profile);
    const response = await call("GET", `/volumes/${name}`);
    if (response.status === 404) return false;
    if (response.status !== 200) throw new Error("Browser profile inspection failed.");
    const found = v.parse(
        v.object({
            Name: v.string(),
            Driver: v.literal("local"),
            Scope: v.literal("local"),
            Labels: v.record(v.string(), v.string()),
            Options: v.nullable(v.record(v.string(), v.string())),
        }),
        response.body
    );
    if (
        found.Name !== name ||
        found.Labels[label] !== profile.id ||
        Object.keys(found.Options ?? {}).length > 0
    )
        throw new Error("Browser profile storage ownership does not match.");
    return true;
}

/** Create exactly one journaled, option-free local volume; callers must record intent before dispatch. */
export async function createBrowserProfileVolume(
    call: BrowserDockerRequest,
    profile: BrowserProfile
) {
    const result = await call("POST", "/volumes/create", {
        Name: browserProfileVolume(profile),
        Driver: "local",
        DriverOpts: {},
        Labels: { [label]: profile.id },
    });
    if (result.status !== 201 || !(await inspectBrowserProfile(call, profile)))
        throw new Error("Browser profile storage creation could not be confirmed.");
}

/** Erase an unused owned volume without forcing a mounted volume; return only after verified absence. */
export async function removeBrowserProfileVolume(
    call: BrowserDockerRequest,
    profile: BrowserProfile
) {
    for (let attempt = 0; attempt < 5; attempt++) {
        if (!(await inspectBrowserProfile(call, profile))) return;
        const result = await call("DELETE", `/volumes/${browserProfileVolume(profile)}`);
        if (
            [204, 404].includes(result.status) &&
            !(await inspectBrowserProfile(call, profile))
        )
            return;
        // AutoRemove can release its volume reference just after container absence.
        // Retry only a settled conflict, never force-remove a volume still mounted elsewhere.
        if (result.status !== 409) break;
        await Bun.sleep(100);
    }
    throw new Error("Browser profile storage deletion could not be confirmed.");
}
