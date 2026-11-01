import { miraPublicationSaveSchema } from "@homelab/contracts/miraPublication";
import type { SQL } from "bun";
import * as v from "valibot";

import { MiraFailure, type MiraContext } from "../../data/context";
import { hereNowBindingCurrent } from "../../data/herenow";
import { listMiraPublications, saveMiraPublication } from "../../data/publications";
import type { MiraClaim } from "../../data/queue";
import type { RuntimeTool } from "../../runtime/protocol";
import {
    hereNowBindingHash,
    hereNowSlugSchema,
    type HereNowReadConfiguration,
} from "./configuration";
import { HereNowReader } from "./reader";

/**
 * Expose HereNow reads and local drafts through the current run's durable tool boundary.
 * @param client - Product connection used to recheck account, pause and run lease.
 * @param run - Leased owned run; arguments cannot select a different account.
 * @param configuration - Service-owned credential and identity, absent before provisioning.
 * @param request - HTTP transport, replace only for synthetic qualification.
 * @returns Scoped read and draft declarations; external publication requires a separate human approval.
 */
export function createHereNowTools(
    client: SQL,
    run: MiraClaim,
    configuration?: HereNowReadConfiguration,
    request: typeof fetch = fetch
): (Omit<RuntimeTool, "execute"> & {
    automatic: boolean;
    transactional?: boolean;
    action: (
        input: unknown,
        signal: AbortSignal,
        context?: MiraContext
    ) => Promise<unknown>;
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
            name: "mira_herenow_publications",
            automatic: true,
            description:
                "Read local publication drafts and outcomes in this conversation. This does not contact here.now or publish anything.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            action: (input) => {
                v.parse(v.strictObject({}), input);
                return listMiraPublications(
                    { client, owner: run.owner, actor: "mira" },
                    { conversationId: run.conversationId }
                );
            },
        },
        {
            name: "mira_herenow_publication_draft",
            automatic: false,
            transactional: true,
            description:
                "Prepare a local public publication draft from files shared in this conversation. Supply a stable UUID and version 0 for a new draft, or the current version to edit. target=null creates a site; updating an existing public site requires its slug and current baseVersionId from a fresh read and replaces every file. No content is uploaded by this tool. Publication requires dashboard approval or Full access through mira_action_execute.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["id", "version", "content"],
                properties: {
                    id: { type: "string" },
                    version: { type: "integer", minimum: 0 },
                    content: {
                        type: "object",
                        additionalProperties: false,
                        required: ["title", "target", "visibility", "files"],
                        properties: {
                            title: { type: "string" },
                            visibility: { const: "anyone_with_link" },
                            target: {
                                anyOf: [
                                    { type: "null" },
                                    {
                                        type: "object",
                                        additionalProperties: false,
                                        required: ["slug", "baseVersionId"],
                                        properties: {
                                            slug: { type: "string" },
                                            baseVersionId: { type: "string" },
                                        },
                                    },
                                ],
                            },
                            files: {
                                type: "array",
                                minItems: 1,
                                maxItems: 8,
                                items: {
                                    type: "object",
                                    additionalProperties: false,
                                    required: ["id", "path"],
                                    properties: {
                                        id: { type: "string" },
                                        path: { type: "string" },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            action: (input, signal, context) => {
                signal.throwIfAborted();
                if (!context?.transaction)
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "Publication drafts require the owned tool transaction."
                    );
                const parsed = v.parse(
                    v.omit(miraPublicationSaveSchema, ["conversationId"]),
                    input
                );
                return saveMiraPublication(
                    context,
                    { ...parsed, conversationId: run.conversationId },
                    configuration
                );
            },
        },
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
                "Read an owned here.now site's current version, file metadata and access policy. Email/domain rules show up to 100 each with total counts and truncation flags. These are separate observations, not an atomic snapshot or authorization to overwrite, replace access lists or publish. Does not fetch file bytes or public URLs.",
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
