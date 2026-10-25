import * as v from "valibot";

const id = v.pipe(v.string(), v.uuid());
const bindingSchema = v.strictObject({
    owner: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(320),
        v.regex(/^[\u0021-\u007E]+$/)
    ),
    organizationId: id,
    snapshotId: id,
    target: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)),
});
export type DaytonaBinding = v.InferOutput<typeof bindingSchema>;
export interface DaytonaConfiguration extends DaytonaBinding {
    apiKey: string;
}

export const daytonaPolicy = Object.freeze({
    version: 1,
    cpu: 2,
    memory: 4,
    disk: 10,
    ttlMinutes: 15,
    queueTimeout: 2,
    bunVersion: "1.4.4",
});

/**
 * Parse the nonsecret owner, organization, immutable snapshot ID and region mapping.
 * @param environment - Explicit service configuration; no legacy profile discovery.
 * @returns Valid binding, or undefined when all settings are absent.
 */
export function daytonaBinding(
    environment: Readonly<Record<string, string | undefined>>
): DaytonaBinding | undefined {
    const owner = environment.HOMELAB_MIRA_DAYTONA_OWNER;
    const organizationId = environment.HOMELAB_MIRA_DAYTONA_ORGANIZATION_ID;
    const snapshotId = environment.HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID;
    const target = environment.HOMELAB_MIRA_DAYTONA_TARGET;
    if (!owner && !organizationId && !snapshotId && !target) return;
    const result = v.safeParse(bindingSchema, {
        owner,
        organizationId,
        snapshotId,
        target,
    });
    if (!result.success)
        throw new Error(
            "Daytona requires an explicit owner, organization, snapshot ID and region."
        );
    return result.output;
}

/**
 * Read one executor-owned credential without inheriting DAYTONA_* or dotenv settings.
 * @param environment - Explicit Homelab service environment.
 * @returns Configured account or undefined before credential provisioning.
 */
export function daytonaConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): DaytonaConfiguration | undefined {
    const binding = daytonaBinding(environment);
    const apiKey = environment.HOMELAB_MIRA_DAYTONA_API_KEY;
    if (!apiKey) return;
    if (!binding || !/^[\u0021-\u007E]{20,2048}$/.test(apiKey))
        throw new Error("Invalid Daytona configuration or credential.");
    return { ...binding, apiKey };
}

/**
 * Bind consent and resource ownership to the configured account and execution policy.
 * @param binding - Operator-owned mapping; credentials may rotate within this account.
 * @returns Stable nonsecret fingerprint, changed by region, snapshot or policy changes.
 */
export function daytonaBindingHash(binding: DaytonaBinding): string {
    const parsed = v.parse(bindingSchema, {
        owner: binding.owner,
        organizationId: binding.organizationId,
        snapshotId: binding.snapshotId,
        target: binding.target,
    });
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([parsed, daytonaPolicy]))
        .digest("hex");
}

/**
 * Derive a stable provider name before sending a create request so lost acknowledgements can be reconciled.
 * @param binding - Original persisted account mapping for this attempt.
 * @param runId - Unique durable product attempt UUID, never reused for another creation.
 * @returns Provider-safe name, containing no email address or credential.
 */
export function daytonaSandboxName(binding: DaytonaBinding, runId: string): string {
    return `mira-${daytonaBindingHash(binding).slice(0, 16)}-${v.parse(id, runId)}`;
}
