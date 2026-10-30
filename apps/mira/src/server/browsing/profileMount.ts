import * as v from "valibot";

import type { BrowserDockerRequest } from "./docker";
import { browserProfileVolume, type BrowserProfile } from "./profile";

/**
 * Refuse a profile mounted by any other running or stopped Docker container.
 * @param call - Trusted local Engine transport.
 * @param profile - The exclusively reserved registry identity.
 * @param current - This newly created container's immutable ID, if it already exists.
 * @returns Completion only when the selected volume has no foreign container references.
 */
export async function requireBrowserProfileMount(
    call: BrowserDockerRequest,
    profile: BrowserProfile,
    current?: string
): Promise<void> {
    const filters = encodeURIComponent(
        JSON.stringify({ volume: [browserProfileVolume(profile)] })
    );
    const response = await call("GET", `/containers/json?all=1&filters=${filters}`);
    if (response.status !== 200)
        throw new Error("Browser profile mount inspection failed.");
    const containers = v.parse(
        v.pipe(
            v.array(v.object({ Id: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)) })),
            v.maxLength(100)
        ),
        response.body
    );
    if (containers.some((container) => container.Id !== current))
        throw new Error("The saved browser profile is mounted by another container.");
}
