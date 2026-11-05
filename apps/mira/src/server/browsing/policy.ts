import path from "node:path";

import { publicBrowserScope } from "@homelab/contracts/miraBrowser";
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
    if (grant.origins.length === 1 && grant.origins[0] === publicBrowserScope) {
        if (grant.savedProfile || grant.uploads || grant.downloads)
            throw new Error(
                "Public browsing requires a temporary profile without file transfers."
            );
        browserUrl(grant.initialUrl, grant.origins);
        return grant;
    }
    const origins = exactBrowserOrigins(grant.origins);
    if (
        (grant.uploads || grant.downloads) &&
        (grant.mode !== "control" || origins.length !== 1)
    )
        throw new Error(
            "Browser file transfers require control of exactly one approved origin."
        );
    browserUrl(grant.initialUrl, origins);
    return { ...grant, origins };
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
    if (!origins.includes(url.origin)) throw new Error("Browser origin is not allowed.");
    return url.href;
}

/**
 * Construct a browser-only ceiling for one fresh driver-owned profile.
 * @param input - Trusted local policy; generic desktop and existing-profile tools are absent.
 * @param uploadRoot - Private session staging root, never a product file-store mount or model path.
 * @param downloadRoot - Private session destination, inaccessible to model arguments.
 * @returns A bounded v3 manifest with an exact blank-page bootstrap and approved web origins.
 */
export function browserManifest(
    input: unknown,
    uploadRoot?: string,
    downloadRoot?: string
) {
    const grant = browserGrant(input);
    if (grant.origins.includes(publicBrowserScope))
        throw new Error("The native driver requires exact website origins.");
    if (
        Boolean(grant.uploads) !== Boolean(uploadRoot) ||
        (uploadRoot && !path.isAbsolute(uploadRoot))
    )
        throw new Error("Browser upload authority requires its private staging root.");
    if (
        Boolean(grant.downloads) !== Boolean(downloadRoot) ||
        (downloadRoot && !path.isAbsolute(downloadRoot))
    )
        throw new Error("Browser download authority requires its private destination.");
    return {
        version: 3,
        expires_after: "5m",
        idle_timeout: "1m",
        allow: {
            tools: [
                "start_session",
                "end_session",
                "list_windows",
                "browser_prepare",
                "get_browser_state",
                "browser_navigate",
                ...(grant.mode === "control" ? ["browser_click", "browser_type"] : []),
                ...(grant.uploads ? ["browser_set_input_files"] : []),
                ...(grant.downloads ? ["browser_download"] : []),
            ],
        },
        resources: {
            apps: [
                {
                    executable: grant.executable,
                    launch: true,
                    windows: "all",
                    terminate: "driver_launched",
                },
            ],
            browser: {
                profiles: [{ kind: "isolated" }],
                origins: ["about:blank", ...grant.origins],
            },
            desktop: { display: false },
            ...(uploadRoot || downloadRoot
                ? {
                      files: {
                          ...(uploadRoot
                              ? { read: [{ dir: uploadRoot, recursive: true }] }
                              : {}),
                          ...(downloadRoot
                              ? { write: [{ dir: downloadRoot, recursive: true }] }
                              : {}),
                      },
                  }
                : {}),
        },
    };
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
