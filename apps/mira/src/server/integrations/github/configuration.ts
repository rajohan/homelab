import * as v from "valibot";

export const githubTarget = Object.freeze({
    repository: "rajohan/homelab",
    repositoryId: 1_370_070_466,
    branch: "main",
    login: "mira-2026",
    accountId: 264_348_558,
    author: "Mira",
    email: "mira-2026@agentmail.to",
    apiVersion: "2026-03-10",
});
const bindingSchema = v.strictObject({
    owner: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(320),
        v.regex(/^[\u0021-\u007E]+$/)
    ),
});
export type GitHubBinding = v.InferOutput<typeof bindingSchema>;
export interface GitHubConfiguration extends GitHubBinding {
    token: string;
}

/**
 * Parse an explicit operator binding; repository and GitHub identity are fixed by this adapter.
 * @param environment - Explicit service settings, never inherited CLI credentials.
 * @returns Nonsecret binding, or undefined before provisioning.
 */
export function githubBinding(
    environment: Readonly<Record<string, string | undefined>>
): GitHubBinding | undefined {
    const owner = environment.HOMELAB_MIRA_GITHUB_OWNER;
    if (!owner) return;
    const parsed = v.safeParse(bindingSchema, { owner });
    if (!parsed.success)
        throw new Error("GitHub publication requires an explicit operator owner.");
    return parsed.output;
}
/**
 * Parse a dedicated service token without discovering GH_TOKEN or another user's session.
 * @param environment - Explicit executor configuration; never passed into a model or sandbox.
 * @returns Validated configuration, or undefined until a dedicated credential is provided.
 */
export function githubConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): GitHubConfiguration | undefined {
    const token = environment.HOMELAB_MIRA_GITHUB_TOKEN;
    if (!token) return;
    const binding = githubBinding(environment);
    if (!binding || !/^[\u0021-\u007E]{20,2048}$/.test(token))
        throw new Error(
            "GitHub publication requires an explicit owner and dedicated credential."
        );
    return { ...binding, token };
}
/**
 * Bind future consent to the fixed account, repository and operator independently of token rotation.
 * @param binding - Explicit operator mapping.
 * @returns Nonsecret stable fingerprint for dispatcher and dashboard agreement.
 */
export function githubBindingHash(binding: GitHubBinding): string {
    const parsed = v.parse(bindingSchema, { owner: binding.owner });
    return new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify([
                1,
                parsed.owner,
                githubTarget.accountId,
                githubTarget.repositoryId,
            ])
        )
        .digest("hex");
}
/**
 * Name one new publication branch without accepting a user-selected ref or protected branch.
 * @param id - Durable publication UUID.
 * @returns The attempt-scoped branch name; existing refs are never updated or removed.
 */
export function githubPublicationBranch(id: string): string {
    return `mira/publication/${v.parse(v.pipe(v.string(), v.uuid()), id).toLowerCase()}`;
}
