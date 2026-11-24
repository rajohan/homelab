/**
 * Read the explicit disposable-image profile marker, without exporting any credentials.
 * @returns Snapshot marker or undefined outside the check image; never a security attestation.
 */
export function sandboxProfileEnvironment(): string | undefined {
    return process.env.HOMELAB_MIRA_SANDBOX_PROFILE;
}

/**
 * Select the fixed public-egress proxy inside a locally isolated check container.
 * @returns Only constant proxy variables when explicitly enabled; inherited proxy URLs are never used.
 */
export function sandboxProxyEnvironment(): Record<string, string> {
    const mode = process.env.HOMELAB_MIRA_LOCAL_EGRESS;
    if (mode === undefined) return {};
    if (mode !== "public") throw new Error("Invalid local check network mode.");
    return {
        HTTP_PROXY: "http://mira-egress:3128",
        HTTPS_PROXY: "http://mira-egress:3128",
        http_proxy: "http://mira-egress:3128",
        https_proxy: "http://mira-egress:3128",
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
    };
}
