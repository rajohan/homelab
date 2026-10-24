import * as v from "valibot";

const identifier = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(320),
    v.regex(/^[\u0021-\u007E]+$/)
);
const bindingSchema = v.strictObject({ owner: identifier, inboxId: identifier });
export type AgentMailBinding = v.InferOutput<typeof bindingSchema>;
export interface AgentMailHookConfiguration extends AgentMailBinding {
    signingSecret: string;
}
export interface AgentMailReadConfiguration extends AgentMailBinding {
    apiKey: string;
    sendApiKey?: string;
}

/**
 * Parse one explicitly provisioned inbox and its Homelab owner; no browser can choose this mapping.
 * @param environment - Values supplied by the application's typed environment boundary.
 * @returns The binding, or undefined when AgentMail is not provisioned.
 */
export function agentMailBinding(
    environment: Readonly<Record<string, string | undefined>>
): AgentMailBinding | undefined {
    const owner = environment.HOMELAB_MIRA_AGENTMAIL_OWNER;
    const inboxId = environment.HOMELAB_MIRA_AGENTMAIL_INBOX;
    if (!owner && !inboxId) return;
    try {
        return v.parse(bindingSchema, { owner, inboxId });
    } catch {
        throw new Error("AgentMail requires an explicit owner and inbox.");
    }
}

/**
 * Read only the webhook credential needed by the dashboard receiver.
 * @param environment - Explicit environment values; the model child never receives these secrets.
 * @returns The receiver settings, or undefined before provisioning.
 */
export function agentMailHookConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): AgentMailHookConfiguration | undefined {
    const binding = agentMailBinding(environment);
    const signingSecret = environment.HOMELAB_MIRA_AGENTMAIL_WEBHOOK_SECRET;
    if (!signingSecret) return;
    if (!binding || !/^whsec_[A-Za-z0-9+/]{20,200}={0,2}$/.test(signingSecret))
        throw new Error("AgentMail webhook configuration is incomplete or invalid.");
    return { ...binding, signingSecret };
}

/**
 * Read only the provider credential needed by the independent Mira executor.
 * @param environment - Explicit environment values supplied by the service owner.
 * @returns Bound read settings, or undefined before provisioning.
 */
export function agentMailReadConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): AgentMailReadConfiguration | undefined {
    const binding = agentMailBinding(environment);
    const apiKey = environment.HOMELAB_MIRA_AGENTMAIL_API_KEY;
    const sendApiKey = environment.HOMELAB_MIRA_AGENTMAIL_SEND_API_KEY;
    if (!apiKey && !sendApiKey) return;
    if (
        !binding ||
        !apiKey ||
        !/^[\u0021-\u007E]{20,2048}$/.test(apiKey) ||
        (sendApiKey !== undefined && !/^[\u0021-\u007E]{20,2048}$/.test(sendApiKey))
    )
        throw new Error("AgentMail read configuration is incomplete or invalid.");
    return { ...binding, apiKey, ...(sendApiKey ? { sendApiKey } : {}) };
}

/**
 * Identify an inbox/account agreement without exposing its address in runtime status.
 * @param binding - Explicit operator-owned inbox mapping.
 * @returns Stable SHA-256 fingerprint, excluding all credentials.
 */
export function agentMailBindingHash(binding: AgentMailBinding): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([binding.owner, binding.inboxId]))
        .digest("hex");
}
