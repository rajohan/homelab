/**
 * Read an explicitly selected policy without exposing its contents in errors.
 * @param path Deployment-owned YAML path.
 * @returns An untrusted document for the strict configuration schema.
 */
export async function loadAccessPolicy(path: string | undefined): Promise<unknown> {
    if (!path?.trim()) throw new Error("HOMELAB_AUTH_POLICY_FILE is required");
    const file = Bun.file(path);
    if (!(await file.exists()) || file.size > 262_144)
        throw new Error("The access policy file is unavailable or exceeds 256 KiB");
    try {
        return Bun.YAML.parse(await file.text());
    } catch {
        throw new Error("The access policy must contain valid YAML");
    }
}
