import * as v from "valibot";

import { browserEgressSchema } from "../browsing/egress";
import type { MiraQuery } from "../data/context";
import type { DaytonaBinding } from "../integrations/daytona/configuration";

export const localCodeBindingSchema = v.strictObject({
    kind: v.literal("main"),
    owner: v.pipe(v.string(), v.minLength(1), v.maxLength(320)),
    hostId: v.pipe(v.string(), v.uuid()),
    imageId: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
    egress: browserEgressSchema,
});
export type LocalCodeBinding = v.InferOutput<typeof localCodeBindingSchema>;
export type CodeJobBinding = DaytonaBinding | LocalCodeBinding;

/**
 * Distinguish an explicit Main target from existing Daytona bindings.
 * @param binding - Trusted typed target; persisted Main data is separately validated.
 * @returns Whether the local execution boundary applies.
 */
export function isLocalCodeBinding(binding: CodeJobBinding): binding is LocalCodeBinding {
    return "kind" in binding && binding.kind === "main";
}

/**
 * Bind consent to the owner, original host, immutable image and dedicated network.
 * @param binding - Nonsecret local deployment selection, without a Docker socket path.
 * @returns Fingerprint of the fixed local execution policy and validated selection.
 */
export function localCodeBindingHash(binding: LocalCodeBinding): string {
    return new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify(["local-code-v1", v.parse(localCodeBindingSchema, binding)])
        )
        .digest("hex");
}

/**
 * Check explicit local-code consent and a current trusted-host heartbeat.
 * @param query - Owner-controls-locked transaction or read connection.
 * @param binding - Exact owner and deployment reviewed by the operator.
 * @returns Current consent version, or null when paused, stale or reconfigured.
 */
export async function localCodePermission(
    query: MiraQuery,
    binding: LocalCodeBinding
): Promise<number | null> {
    const hash = localCodeBindingHash(binding);
    const [row] = await query<
        { version: number }[]
    >`SELECT s.version FROM mira_switches s WHERE s.owner=${binding.owner} AND s.key='code:main' AND s.enabled AND s.binding_hash=${hash} AND EXISTS(SELECT 1 FROM mira_integration_receivers WHERE key='code:main' AND binding_hash=${hash} AND heartbeat_at>clock_timestamp()-interval '45 seconds')`;
    return row?.version ?? null;
}

/**
 * Publish the local host's nonsecret availability without enabling code execution.
 * @param query - Trusted host's product connection.
 * @param binding - Validated current owner, host, image and network.
 * @returns Completion after the heartbeat commits.
 */
export async function publishLocalCodeBinding(
    query: MiraQuery,
    binding: LocalCodeBinding
): Promise<void> {
    await query`INSERT INTO mira_integration_receivers(key,binding_hash,heartbeat_at) VALUES('code:main',${localCodeBindingHash(binding)},clock_timestamp()) ON CONFLICT(key) DO UPDATE SET binding_hash=EXCLUDED.binding_hash,heartbeat_at=EXCLUDED.heartbeat_at`;
}
