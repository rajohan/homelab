import {
    githubBindingHash,
    type GitHubBinding,
} from "../integrations/github/configuration";
import type { MiraContext, MiraQuery } from "./context";

/**
 * Publish the dashboard's nonsecret GitHub mapping, including explicit removal.
 * @param query - Dashboard connection or test transaction.
 * @param binding - Operator-owned account mapping; absence revokes earlier configuration.
 * @returns Completion after the current mapping and heartbeat are committed.
 */
export async function publishGitHubBinding(
    query: MiraQuery,
    binding?: GitHubBinding
): Promise<void> {
    const hash = binding ? githubBindingHash(binding) : null;
    await query`INSERT INTO mira_integration_receivers(key,binding_hash,heartbeat_at) VALUES ('github',${hash},now()) ON CONFLICT(key) DO UPDATE SET binding_hash=EXCLUDED.binding_hash,heartbeat_at=EXCLUDED.heartbeat_at`;
}

/**
 * Fence reads against a recently published matching dashboard account.
 * @param query - Product connection.
 * @param binding - Executor's fixed operator/account mapping.
 * @returns Whether the dashboard still confirms this exact binding.
 */
export async function githubBindingCurrent(
    query: MiraQuery,
    binding: GitHubBinding
): Promise<boolean> {
    const [row] = await query<
        { current: boolean }[]
    >`SELECT binding_hash=${githubBindingHash(binding)} AND heartbeat_at>clock_timestamp()-interval '45 seconds' AS current FROM mira_integration_receivers WHERE key='github'`;
    return row?.current === true;
}

/**
 * Describe availability without exposing credentials, account names or another owner's settings.
 * @param context - Verified human account.
 * @param binding - Dashboard's nonsecret provisioned mapping.
 * @returns Shared integration-card status, independent of deliberate pause.
 */
export async function githubIntegrationStatus(
    context: MiraContext,
    binding?: GitHubBinding
) {
    const base = {
        key: "integration:github",
        title: "GitHub",
        description: "Publish reviewed, tested code changes as draft pull requests.",
        configured: false,
        ready: false,
        message: null as string | null,
        lastSuccessAt: null as string | null,
    };
    if (!binding || binding.owner !== context.owner) return base;
    const hash = githubBindingHash(binding);
    const [runtime] = await context.client<
        { matched: boolean; fresh: boolean }[]
    >`SELECT integrations @> ${JSON.stringify([{ owner: binding.owner, key: "github", bindingHash: hash }])}::text::jsonb AS matched,heartbeat_at>clock_timestamp()-interval '45 seconds' AS fresh FROM mira_runtime_status WHERE id=1`;
    const [control] = await context.client<
        { enabled: boolean; granted: boolean }[]
    >`SELECT enabled,binding_hash=${hash} AS granted FROM mira_switches WHERE owner=${context.owner} AND key='integration:github'`;
    const configured = runtime?.matched === true;
    const confirmed = !control?.enabled || control.granted;
    let message: string | null = null;
    if (!configured)
        message =
            "Dashboard and Mira must be configured with the same GitHub account before enabling this integration.";
    else if (!confirmed)
        message = "Pause and enable GitHub to confirm the new account binding.";
    return {
        ...base,
        configured,
        ready: configured && runtime.fresh && confirmed,
        message,
    };
}
