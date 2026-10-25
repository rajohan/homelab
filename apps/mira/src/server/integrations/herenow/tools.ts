import type { SQL } from "bun";
import * as v from "valibot";

import { MiraFailure } from "../../data/context";
import { hereNowBindingCurrent } from "../../data/herenow";
import type { MiraClaim } from "../../data/queue";
import type { RuntimeTool } from "../../runtime/protocol";
import {
    hereNowBindingHash,
    hereNowSlugSchema,
    type HereNowReadConfiguration,
} from "./configuration";
import { HereNowReader } from "./reader";

/**
 * Expose passive HereNow reads through the current run's durable tool boundary.
 * @param client - Product connection used to recheck account, pause and run lease.
 * @param run - Leased owned run; arguments cannot select a different account.
 * @param configuration - Service-owned credential and identity, absent before provisioning.
 * @param request - HTTP transport, replace only for synthetic qualification.
 * @returns Stable read declarations for manual and automatic runs; no publishing or notification acknowledgement.
 */
export function createHereNowTools(
    client: SQL,
    run: MiraClaim,
    configuration?: HereNowReadConfiguration,
    request: typeof fetch = fetch
): (Omit<RuntimeTool, "execute"> & {
    automatic: boolean;
    action: (input: unknown, signal: AbortSignal) => Promise<unknown>;
})[] {
    const reader = configuration ? new HereNowReader(configuration, request) : undefined;
    const access = async (signal: AbortSignal, version?: number) => {
        signal.throwIfAborted();
        if (!configuration || !reader || configuration.owner !== run.owner)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "here.now is not configured for this account."
            );
        const [control] = await client<
            { version: number }[]
        >`SELECT version FROM mira_switches WHERE owner=${run.owner} AND key='integration:here-now' AND enabled AND binding_hash=${hereNowBindingHash(configuration)} AND EXISTS(SELECT 1 FROM mira_runs WHERE id=${run.id} AND owner=${run.owner} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp())`;
        if (
            !control ||
            (version !== undefined && version !== control.version) ||
            !(await hereNowBindingCurrent(client, configuration))
        )
            throw new MiraFailure(
                "FORBIDDEN",
                "here.now is paused or this run no longer has access."
            );
        return control.version;
    };
    const read = async (
        signal: AbortSignal,
        operation: (source: HereNowReader) => Promise<unknown>
    ) => {
        const version = await access(signal);
        let result: unknown;
        try {
            result = await operation(reader!);
        } catch {
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "here.now could not complete this read. Try again later."
            );
        }
        await access(signal, version);
        return { data: result, trust: "untrusted_site_metadata" };
    };
    return [
        {
            name: "mira_herenow_account",
            automatic: true,
            description:
                "Inspect the configured here.now account. This does not list API keys or billing details, change membership or publish anything.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            action: (input, signal) => {
                v.parse(v.strictObject({}), input);
                return read(signal, (source) => source.account(signal));
            },
        },
        {
            name: "mira_herenow_sites",
            automatic: true,
            description:
                "List up to fifty sites in the configured here.now account. Truncation is explicit; this never searches other accounts or fetches site contents.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            action: (input, signal) => {
                v.parse(v.strictObject({}), input);
                return read(signal, (source) => source.sites(signal));
            },
        },
        {
            name: "mira_herenow_site",
            automatic: true,
            description:
                "Read an owned here.now site's current version, file metadata and access policy. These are separate observations, not an atomic snapshot or authorization to overwrite or publish. Does not fetch file bytes or public URLs.",
            inputSchema: {
                type: "object",
                properties: { slug: { type: "string" } },
                required: ["slug"],
                additionalProperties: false,
            },
            action: (input, signal) => {
                const { slug } = v.parse(
                    v.strictObject({ slug: hereNowSlugSchema }),
                    input
                );
                return read(signal, (source) => source.site(slug, signal));
            },
        },
    ];
}
