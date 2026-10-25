import * as v from "valibot";

const identifier = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[A-Za-z0-9_-]+$/)
);
export const moltbookIdSchema = identifier;
const bindingSchema = v.strictObject({
    owner: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(320),
        v.regex(/^[\u0021-\u007E]+$/)
    ),
    agentName: identifier,
});
export type MoltbookBinding = v.InferOutput<typeof bindingSchema>;
export interface MoltbookReadConfiguration extends MoltbookBinding {
    apiKey: string;
}

/**
 * Parse the operator-owned account mapping shared by dashboard and executor.
 * @param environment - Explicit service settings; the dashboard needs no provider credential.
 * @returns Nonsecret account binding, or undefined before provisioning.
 */
export function moltbookBinding(
    environment: Readonly<Record<string, string | undefined>>
): MoltbookBinding | undefined {
    const owner = environment.HOMELAB_MIRA_MOLTBOOK_OWNER;
    const agentName = environment.HOMELAB_MIRA_MOLTBOOK_AGENT_NAME;
    if (!owner && !agentName) return;
    const result = v.safeParse(bindingSchema, { owner, agentName });
    if (!result.success)
        throw new Error("Moltbook requires an explicit owner and agent name.");
    return result.output;
}

/**
 * Parse an explicit Moltbook account mapping without discovering credentials from legacy profiles.
 * @param environment - Service-owned environment; secrets stay outside the model child.
 * @returns A validated owner, expected agent name and read credential, or undefined before provisioning.
 */
export function moltbookReadConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): MoltbookReadConfiguration | undefined {
    const binding = moltbookBinding(environment);
    const apiKey = environment.HOMELAB_MIRA_MOLTBOOK_API_KEY;
    if (!apiKey) return;
    if (!binding || !/^[\u0021-\u007E]{20,2048}$/.test(apiKey))
        throw new Error(
            "Moltbook requires an explicit owner, agent name and API credential."
        );
    return { ...binding, apiKey };
}

/**
 * Bind operator consent to an account identity independently of credential rotation.
 * @param configuration - Provisioned owner and expected Moltbook agent.
 * @returns Nonsecret account fingerprint for control and runtime agreement.
 */
export function moltbookBindingHash(
    configuration: Pick<MoltbookReadConfiguration, "owner" | "agentName">
): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([configuration.owner, configuration.agentName]))
        .digest("hex");
}
