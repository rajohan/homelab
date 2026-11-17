/** Read an immutable release version for a logical service role.
 * @param repository - Trusted owner/repository publication source.
 * @param app - Logical manifest role, independent of its registry package.
 * @param reference - Fully qualified tag and digest from a release or installed service.
 * @returns The exact version, or null for an unrelated package or malformed reference.
 */
export function releaseImageVersion(
    repository: string,
    app: string,
    reference: string
): string | null {
    const packageName = ["mira", "mira-browser", "daytona-check"].includes(app)
        ? "dashboard"
        : app;
    for (const name of new Set([packageName, app])) {
        const prefix = `ghcr.io/${repository.toLowerCase()}/${name}:`;
        if (!reference.startsWith(prefix)) continue;
        const match = /^(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}$/.exec(
            reference.slice(prefix.length)
        );
        if (match) return match[1]!;
    }
    return null;
}
