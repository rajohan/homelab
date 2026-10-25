import * as v from "valibot";

import { integrationJson } from "../http";
import { hereNowSlugSchema, type HereNowReadConfiguration } from "./configuration";

const text = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const id = v.pipe(v.string(), v.uuid());
const version = v.nullable(text(128));
const siteSchema = v.object({
    slug: hereNowSlugSchema,
    status: text(64),
    currentVersionId: version,
    pendingVersionId: version,
    updatedAt: text(100),
    expiresAt: v.nullable(text(100)),
});
const accountSchema = v.object({
    accountId: id,
    type: v.picklist(["personal", "org"]),
    displayName: text(256),
    status: v.picklist(["active", "suspended", "deleted"]),
    provisioningStatus: text(64),
    role: v.picklist(["admin", "member"]),
});

const fileSchema = v.object({
    path: text(1024),
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    contentType: v.optional(text(200)),
    hash: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
});

/** Read fixed-origin here.now metadata without visiting public sites, downloading files or publishing. */
export class HereNowReader {
    private readonly configuration: HereNowReadConfiguration;
    private readonly request: typeof fetch;
    /**
     * Bind one immutable account and an executor-owned credential.
     * @param configuration - Provisioned owner and account ID; no model-selected account.
     * @param request - HTTP transport, replace only for synthetic qualification.
     */
    constructor(configuration: HereNowReadConfiguration, request: typeof fetch = fetch) {
        this.configuration = configuration;
        this.request = request;
    }
    private async json(
        path: string,
        signal: AbortSignal,
        maximumBytes = 2 * 1024 * 1024
    ): Promise<unknown> {
        signal.throwIfAborted();
        const response = await this.request(`https://here.now/api/v1/${path}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${this.configuration.apiKey}`,
                "X-HereNow-Account": this.configuration.accountId,
                "X-HereNow-Client": "homelab/mira",
                Accept: "application/json",
            },
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        return integrationJson(response, maximumBytes);
    }
    /**
     * Verify the selected account and project only that account's passive metadata.
     * @param signal - Run cancellation and service shutdown.
     * @returns Matching active account, excluding other memberships, credentials and billing data.
     */
    async account(signal: AbortSignal) {
        const parsed = v.parse(
            v.object({
                accounts: v.pipe(v.array(accountSchema), v.maxLength(1000)),
                currentAccountId: v.nullable(id),
                selectorError: v.nullish(v.never()),
            }),
            await this.json("accounts", signal)
        );
        const selected = parsed.accounts.filter(
            (account) => account.accountId === this.configuration.accountId
        );
        if (
            parsed.currentAccountId !== this.configuration.accountId ||
            selected.length !== 1 ||
            selected[0]!.status !== "active"
        )
            throw new Error("here.now does not confirm the configured account.");
        return selected[0]!;
    }
    /**
     * Read the selected account's site inventory, capped independently of provider pagination.
     * @param signal - Cancellation covering both account verification and inventory.
     * @returns Up to fifty metadata rows and explicit truncation; no cross-account scope is requested.
     */
    async sites(signal: AbortSignal) {
        await this.account(signal);
        const parsed = v.parse(
            v.object({ publishes: v.pipe(v.array(siteSchema), v.maxLength(5000)) }),
            await this.json("publishes", signal)
        );
        return {
            sites: parsed.publishes
                .slice(0, 50)
                .map((site) => ({ ...site, url: `https://${site.slug}.here.now/` })),
            truncated: parsed.publishes.length > 50,
        };
    }
    /**
     * Inspect one owned site's current version, file manifest and access policy.
     * @param slug - Validated provider identifier, never an external URL.
     * @param signal - Cancellation covering account, metadata and access reads.
     * @returns Separate observations of version and sharing state; no file bytes or access credentials.
     */
    async site(slug: string, signal: AbortSignal) {
        const parsed = v.parse(hereNowSlugSchema, slug);
        await this.account(signal);
        const details = v.parse(
            v.object({
                ...siteSchema.entries,
                displayName: v.nullish(text(80), null),
                displayDescription: v.nullish(text(280), null),
                currentVersionSource: v.nullable(text(128)),
                currentVersionCreatedAt: v.nullable(text(100)),
                manifest: v.pipe(v.array(fileSchema), v.maxLength(5000)),
            }),
            await this.json(`publish/${encodeURIComponent(parsed)}`, signal)
        );
        if (details.slug !== parsed)
            throw new Error("here.now returned a different site.");
        const { access } = v.parse(
            v.object({
                access: v.object({
                    mode: v.picklist([
                        "anyone_with_link",
                        "password",
                        "restricted",
                        "account_members",
                    ]),
                    accessPolicyVersion: v.pipe(v.number(), v.integer(), v.minValue(0)),
                    allowedEmails: v.pipe(v.array(text(320)), v.maxLength(10_000)),
                    allowedDomains: v.pipe(v.array(text(255)), v.maxLength(10_000)),
                }),
            }),
            await this.json(
                `publish/${encodeURIComponent(parsed)}/access`,
                signal,
                8 * 1024 * 1024
            )
        );
        return {
            ...details,
            url: `https://${parsed}.here.now/`,
            manifest: details.manifest.slice(0, 100),
            manifestTruncated: details.manifest.length > 100,
            access: {
                ...access,
                allowedEmails: access.allowedEmails.slice(0, 100),
                allowedDomains: access.allowedDomains.slice(0, 100),
                allowedEmailCount: access.allowedEmails.length,
                allowedDomainCount: access.allowedDomains.length,
                allowedEmailsTruncated: access.allowedEmails.length > 100,
                allowedDomainsTruncated: access.allowedDomains.length > 100,
            },
        };
    }
}
