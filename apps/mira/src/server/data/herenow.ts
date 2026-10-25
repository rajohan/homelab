import {
    hereNowBindingHash,
    type HereNowBinding,
} from "../integrations/herenow/configuration";
import type { MiraContext, MiraQuery } from "./context";

/**
 * Publish the dashboard's nonsecret HereNow mapping, including explicit removal.
 * @param query - Dashboard connection or test transaction.
 * @param binding - Operator-owned account mapping; absence revokes earlier configuration.
 * @returns Completion after the current mapping and heartbeat are committed.
 */
export async function publishHereNowBinding(
    query: MiraQuery,
    binding?: HereNowBinding
): Promise<void> {
    const hash = binding ? hereNowBindingHash(binding) : null;
    await query`INSERT INTO mira_integration_receivers(key,binding_hash,heartbeat_at) VALUES ('here-now',${hash},now()) ON CONFLICT(key) DO UPDATE SET binding_hash=EXCLUDED.binding_hash,heartbeat_at=EXCLUDED.heartbeat_at`;
}

/**
 * Fence reads against a recently published matching dashboard account.
 * @param query - Product connection.
 * @param binding - Executor's fixed operator/account mapping.
 * @returns Whether the dashboard still confirms this exact binding.
 */
export async function hereNowBindingCurrent(
    query: MiraQuery,
    binding: HereNowBinding
): Promise<boolean> {
    const [row] = await query<
        { current: boolean }[]
    >`SELECT binding_hash=${hereNowBindingHash(binding)} AND heartbeat_at>clock_timestamp()-interval '45 seconds' AS current FROM mira_integration_receivers WHERE key='here-now'`;
    return row?.current === true;
}

/**
 * Describe availability without exposing credentials, account names or another owner's settings.
 * @param context - Verified human account.
 * @param binding - Dashboard's nonsecret provisioned mapping.
 * @returns Shared integration-card status, independent of deliberate pause.
 */
export async function hereNowIntegrationStatus(
    context: MiraContext,
    binding?: HereNowBinding
) {
    const base = {
        key: "integration:here-now",
        title: "here.now",
        description: "Inspect your sites, published versions and sharing settings.",
        configured: false,
        ready: false,
        message: null as string | null,
        lastSuccessAt: null as string | null,
    };
    if (!binding || binding.owner !== context.owner) return base;
    const hash = hereNowBindingHash(binding);
    const [runtime] = await context.client<
        { matched: boolean; fresh: boolean }[]
    >`SELECT integrations @> ${JSON.stringify([{ owner: binding.owner, key: "here-now", bindingHash: hash }])}::text::jsonb AS matched,heartbeat_at>clock_timestamp()-interval '45 seconds' AS fresh FROM mira_runtime_status WHERE id=1`;
    const [control] = await context.client<
        { enabled: boolean; granted: boolean }[]
    >`SELECT enabled,binding_hash=${hash} AS granted FROM mira_switches WHERE owner=${context.owner} AND key='integration:here-now'`;
    const configured = runtime?.matched === true;
    const confirmed = !control?.enabled || control.granted;
    let message: string | null = null;
    if (!configured)
        message =
            "Dashboard and Mira must be configured with the same here.now account before enabling this integration.";
    else if (!confirmed)
        message = "Pause and enable here.now to confirm the new account binding.";
    return {
        ...base,
        configured,
        ready: configured && runtime.fresh && confirmed,
        message,
    };
}
