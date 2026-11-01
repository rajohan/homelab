import { readFileSync } from "node:fs";
import path from "node:path";

import * as v from "valibot";

import { browserEgressSchema } from "../browsing/egress";
import type { MiraContext, MiraQuery } from "../data/context";
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
 * Read the same nonsecret local target in the dashboard, executor and trusted host.
 * @param environment - Explicit service environment; no host socket or provider credential is accepted.
 * @returns Validated target, or undefined when local execution has not been provisioned.
 */
export function localCodeEnvironment(
    environment: Readonly<Record<string, string | undefined>>
): LocalCodeBinding | undefined {
    const inline = environment.HOMELAB_MIRA_LOCAL_CODE;
    const file = environment.HOMELAB_MIRA_LOCAL_CODE_FILE;
    if (file && (inline || !path.isAbsolute(file)))
        throw new Error("Local code requires one explicit configuration source.");
    const value = file ? readFileSync(file, "utf8") : inline;
    return value ? v.parse(localCodeBindingSchema, JSON.parse(value)) : undefined;
}

/**
 * Describe the current owner's local target without disclosing deployment identities.
 * @param context - Authenticated operator.
 * @param binding - Dashboard's nonsecret deployment selection.
 * @returns Availability independent of intentional pause, with changed bindings requiring renewed consent.
 */
export async function localCodeStatus(context: MiraContext, binding?: LocalCodeBinding) {
    const base = {
        key: "code:main",
        title: "Main code execution",
        description:
            "Run reviewed Homelab checks on Main. Cleanup continues while paused.",
        configured: false,
        ready: false,
        message: null as string | null,
        lastSuccessAt: null as string | null,
    };
    if (!binding || binding.owner !== context.owner) return base;
    const hash = localCodeBindingHash(binding);
    const [row] = await context.client<{ current: boolean; granted: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM mira_integration_receivers WHERE key='code:main' AND binding_hash=${hash} AND heartbeat_at>clock_timestamp()-interval '45 seconds') AS current,
        NOT EXISTS(SELECT 1 FROM mira_switches WHERE owner=${context.owner} AND key='code:main' AND enabled AND binding_hash IS DISTINCT FROM ${hash}) AS granted`;
    let message: string | null = null;
    if (!row?.current)
        message = "Main's code host is offline or its configuration differs.";
    else if (!row.granted)
        message =
            "Pause and enable Main code execution to confirm the changed host configuration.";
    return {
        ...base,
        configured: true,
        ready: row?.current === true && row.granted,
        message,
    };
}

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
 * @returns Exact persisted heartbeat timestamp for conditional retirement on shutdown.
 */
export async function publishLocalCodeBinding(
    query: MiraQuery,
    binding: LocalCodeBinding
): Promise<string> {
    const [row] = await query<
        { stamp: string }[]
    >`INSERT INTO mira_integration_receivers(key,binding_hash,heartbeat_at) VALUES('code:main',${localCodeBindingHash(binding)},clock_timestamp()) ON CONFLICT(key) DO UPDATE SET binding_hash=EXCLUDED.binding_hash,heartbeat_at=EXCLUDED.heartbeat_at RETURNING heartbeat_at::text AS stamp`;
    return row!.stamp;
}
