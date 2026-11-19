import path from "node:path";

import {
    connectedBrowserScope,
    internetBrowserScope,
    publicBrowserScope,
    unrestrictedBrowserSites,
} from "@homelab/contracts/miraBrowser";
import * as v from "valibot";

const address = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
const grantSchema = v.strictObject({
    executable: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    origins: v.pipe(v.array(address), v.minLength(1), v.maxLength(16)),
    initialUrl: address,
    mode: v.picklist(["view", "control"]),
    savedProfile: v.optional(v.literal(true)),
    uploads: v.optional(v.literal(true)),
    downloads: v.optional(v.literal(true)),
});
export type BrowserGrant = v.InferOutput<typeof grantSchema>;

/**
 * Validate a trusted host's dedicated-browser grant, never model-selected policy.
 * @param input - Canonical browser executable, exact origins and initial document.
 * @returns An independent grant with no existing-profile or desktop authority.
 */
export function browserGrant(input: unknown): BrowserGrant {
    const grant = v.parse(grantSchema, input);
    if (!path.isAbsolute(grant.executable))
        throw new Error("Browser executable must be an absolute local path.");
    if (unrestrictedBrowserSites(grant.origins)) {
        if ((grant.uploads || grant.downloads) && grant.mode !== "control")
            throw new Error("File transfers require control access.");
        browserUrl(grant.initialUrl, grant.origins);
        return grant;
    }
    throw new Error("Legacy exact-site browser sessions are no longer supported.");
}

/** Validate the immutable site list for an exact-site session or saved sign-in.
 * @param sites - Parsed list of requested website origins.
 * @returns A copy containing only unique canonical HTTP(S) origins.
 */
export function exactBrowserOrigins(sites: readonly string[]): string[] {
    const origins = sites.map((origin) => {
        const url = webUrl(origin);
        if (url.origin !== origin)
            throw new Error("Browser origins must be exact canonical origins.");
        return origin;
    });
    if (new Set(origins).size !== origins.length)
        throw new Error("Browser origins must be unique.");
    return origins;
}

/**
 * Admit one HTTP(S) document only inside the trusted origin ceiling.
 * @param input - Navigation destination or independently observed live URL.
 * @param origins - Exact host-approved origins, including scheme and port.
 * @returns Canonical URL, without credentials or alternate protocol handlers.
 */
export function browserUrl(input: unknown, origins: readonly string[]): string {
    const url = webUrl(v.parse(address, input));
    if (origins.length === 1 && origins[0] === publicBrowserScope) {
        const host = url.hostname.toLowerCase().replace(/\.$/u, "");
        if (
            url.port ||
            !host.includes(".") ||
            /^[0-9.]+$/u.test(host) ||
            host.includes(":") ||
            /(?:^|\.)(?:localhost|local|internal|lan|home|onion|home\.arpa|home\.rajohan\.no)$/u.test(
                host
            )
        )
            throw new Error("Choose a public website on a standard web port.");
        return url.href;
    }
    if (
        origins.length === 1 &&
        (origins[0] === connectedBrowserScope || origins[0] === internetBrowserScope)
    )
        return url.href;
    if (!origins.includes(url.origin)) throw new Error("Browser origin is not allowed.");
    return url.href;
}

function webUrl(input: string): URL {
    const url = new URL(input);
    if (
        !input.isWellFormed() ||
        /[\s\\\p{Cc}]/u.test(input) ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
    )
        throw new Error("Browser URL must use HTTP or HTTPS without credentials.");
    return url;
}
