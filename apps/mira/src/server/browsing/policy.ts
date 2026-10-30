import path from "node:path";

import * as v from "valibot";

const address = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
const grantSchema = v.strictObject({
    executable: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    origins: v.pipe(v.array(address), v.minLength(1), v.maxLength(16)),
    initialUrl: address,
    mode: v.picklist(["view", "control"]),
    savedProfile: v.optional(v.literal(true)),
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
    const origins = grant.origins.map((origin) => {
        const url = webUrl(origin);
        if (url.origin !== origin)
            throw new Error("Browser origins must be exact canonical origins.");
        return origin;
    });
    if (new Set(origins).size !== origins.length)
        throw new Error("Browser origins must be unique.");
    browserUrl(grant.initialUrl, origins);
    return { ...grant, origins };
}

/**
 * Admit one HTTP(S) document only inside the trusted origin ceiling.
 * @param input - Navigation destination or independently observed live URL.
 * @param origins - Exact host-approved origins, including scheme and port.
 * @returns Canonical URL, without credentials or alternate protocol handlers.
 */
export function browserUrl(input: unknown, origins: readonly string[]): string {
    const url = webUrl(v.parse(address, input));
    if (!origins.includes(url.origin)) throw new Error("Browser origin is not allowed.");
    return url.href;
}

/**
 * Construct a browser-only ceiling for one fresh driver-owned profile.
 * @param input - Trusted local policy; generic desktop and existing-profile tools are absent.
 * @returns A bounded v3 manifest with an exact blank-page bootstrap and approved web origins.
 */
export function browserManifest(input: unknown) {
    const grant = browserGrant(input);
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
