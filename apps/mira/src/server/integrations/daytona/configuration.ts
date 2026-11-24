import * as v from "valibot";

import { daytonaCheckProfile } from "../../sandbox/profile";
import { daytonaPlatformUser, platformProgramHash } from "./platform";

const id = v.pipe(v.string(), v.uuid());
const bindingSchema = v.strictObject({
    trustBoundary: v.literal("dedicated-organization"),
    networkAccess: v.literal("provider-default"),
    owner: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(320),
        v.regex(/^[\u0021-\u007E]+$/)
    ),
    organizationId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/)),
    snapshotId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/)),
    projectId: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/))),
    platformImage: v.optional(
        v.strictObject({
            source: v.pipe(
                v.string(),
                v.regex(
                    /^docker\.io\/daytonaio\/[a-z0-9][a-z0-9._-]{0,126}@sha256:[a-f0-9]{64}$/
                )
            ),
            bootstrapSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        })
    ),
    target: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)),
});
export type DaytonaBinding = v.InferOutput<typeof bindingSchema>;
export interface DaytonaConfiguration extends DaytonaBinding {
    apiKey: string;
}

export interface DaytonaExecutionConfiguration extends DaytonaConfiguration {
    executionQualified: boolean;
}

const stableBunPolicy = Object.freeze({
    version: 2,
    cpu: 4,
    memory: 8,
    disk: 10,
    idleMinutes: 5,
    bunVersion: "1.4.4",
});

export const daytonaPolicy = Object.freeze({
    ...stableBunPolicy,
    version: 3,
    bunVersion: daytonaCheckProfile.bunVersion,
    bunRevision: daytonaCheckProfile.bunRevision,
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
    const projectId = environment.HOMELAB_MIRA_DAYTONA_PROJECT_ID;
    const imageId = environment.HOMELAB_MIRA_DAYTONA_IMAGE_ID;
    const platformSource = environment.HOMELAB_MIRA_DAYTONA_PLATFORM_SOURCE;
    const snapshotId = imageId || environment.HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID;
    const target = environment.HOMELAB_MIRA_DAYTONA_TARGET;
    const trustBoundary = environment.HOMELAB_MIRA_DAYTONA_TRUST_BOUNDARY;
    const networkAccess = environment.HOMELAB_MIRA_DAYTONA_NETWORK_ACCESS;
    if (
        !owner &&
        !organizationId &&
        !snapshotId &&
        !projectId &&
        !platformSource &&
        !target &&
        !trustBoundary &&
        !networkAccess
    )
        return;
    const result = v.safeParse(bindingSchema, {
        trustBoundary,
        networkAccess,
        owner,
        organizationId,
        snapshotId,
        target,
        ...(projectId ? { projectId } : {}),
        ...(platformSource
            ? {
                  platformImage: {
                      source: platformSource,
                      bootstrapSha256: platformProgramHash(),
                  },
              }
            : {}),
    });
    if (
        !result.success ||
        Boolean(imageId) !== Boolean(projectId) ||
        (platformSource && !imageId) ||
        (projectId
            ? !/^img_[A-Za-z0-9_-]+$/.test(snapshotId ?? "")
            : !v.safeParse(id, snapshotId).success)
    )
        throw new Error(
            "Daytona requires a dedicated organization, network policy, owner and region, plus a v2 project and immutable image ID or the original snapshot for legacy cleanup."
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
 * Project a binding onto its durable nonsecret identity for storage and fingerprinting.
 * @param binding - Operator-owned mapping, possibly including executor-only credential fields.
 * @returns The exact snapshot or qualified v2 project and image mapping.
 */
export function daytonaBindingRecord(binding: DaytonaBinding): DaytonaBinding {
    return v.parse(bindingSchema, {
        trustBoundary: binding.trustBoundary,
        networkAccess: binding.networkAccess,
        owner: binding.owner,
        organizationId: binding.organizationId,
        snapshotId: binding.snapshotId,
        target: binding.target,
        ...(binding.projectId ? { projectId: binding.projectId } : {}),
        ...(binding.platformImage ? { platformImage: binding.platformImage } : {}),
    });
}

function bindingHash(binding: DaytonaBinding, policy: object): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([daytonaBindingRecord(binding), policy]))
        .digest("hex");
}

/**
 * Bind new consent and resource ownership to the currently deployed policy.
 * @param binding - Operator-owned mapping, excluding credentials.
 * @returns Current policy fingerprint for new admissions.
 */
export function daytonaBindingHash(binding: DaytonaBinding): string {
    if (binding.platformImage)
        return bindingHash(binding, {
            ...daytonaPolicy,
            platform: 2,
            launcherVersion: 1,
            platformUser: daytonaPlatformUser,
            cpuArchitecture: "amd64",
            noNewPrivileges: true,
        });
    return bindingHash(
        binding,
        binding.projectId ? { ...daytonaPolicy, platform: 2 } : daytonaPolicy
    );
}

/**
 * Verify a persisted attempt fingerprint against its original supported policy.
 * @param binding - Original durable account, snapshot and region mapping.
 * @param recordedHash - Fingerprint captured before the original create attempt.
 * @returns The verified original fingerprint, usable for observation and cleanup only when retired.
 */
export function daytonaOriginalBindingHash(
    binding: DaytonaBinding,
    recordedHash: string
): string {
    const legacy = bindingHash(binding, {
        version: 1,
        cpu: 2,
        memory: 4,
        disk: 10,
        ttlMinutes: 15,
        queueTimeout: 2,
        bunVersion: "1.4.4",
    });
    const previousCanaries = [
        ["1.4.4-canary.20261108.1", "2596ac5d391d47804c93a42bdbe615804aa62387"],
        ["1.4.4-canary.20261118.1", "4ce14ba8b150c3c7315284f3df8480eb4158b38a"],
    ] as const;
    if (
        recordedHash !== daytonaBindingHash(binding) &&
        recordedHash !== legacy &&
        recordedHash !== bindingHash(binding, stableBunPolicy) &&
        !previousCanaries.some(
            ([bunVersion, bunRevision]) =>
                recordedHash ===
                bindingHash(binding, {
                    ...stableBunPolicy,
                    version: 3,
                    bunVersion,
                    bunRevision,
                })
        )
    )
        throw new Error("Unknown Daytona attempt ownership policy.");
    return recordedHash;
}

/**
 * Derive a stable provider name before sending a create request so lost acknowledgements can be reconciled.
 * @param binding - Original persisted account mapping for this attempt.
 * @param runId - Unique durable product attempt UUID, never reused for another creation.
 * @param recordedHash - Original attempt fingerprint; omitted for a new current-policy attempt.
 * @returns Provider-safe name, containing no email address or credential.
 */
export function daytonaSandboxName(
    binding: DaytonaBinding,
    runId: string,
    recordedHash = daytonaBindingHash(binding)
): string {
    return `mira-${daytonaOriginalBindingHash(binding, recordedHash).slice(0, 16)}-${v.parse(id, runId)}`;
}

/**
 * Load credentials for cleanup and separately qualify execution for this exact binding.
 * @param environment - Explicit service environment.
 * @returns Configuration with execution disabled until the operator records qualification.
 */
export function daytonaExecutionConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): DaytonaExecutionConfiguration | undefined {
    const configuration = daytonaConfiguration(environment);
    if (!configuration) return;
    return {
        ...configuration,
        executionQualified:
            Boolean(configuration.projectId) &&
            environment.HOMELAB_MIRA_DAYTONA_QUALIFIED_BINDING_HASH ===
                daytonaBindingHash(configuration),
    };
}
