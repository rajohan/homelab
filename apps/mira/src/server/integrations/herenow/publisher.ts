import type { MiraPublicationContent } from "@homelab/contracts/miraPublication";
import * as v from "valibot";

import { integrationJson } from "../http";
import { hereNowSlugSchema, type HereNowReadConfiguration } from "./configuration";
import { HereNowReader } from "./reader";

const version = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const ownership = v.object({
    requestAuth: v.literal("api_key"),
    ownership: v.picklist(["personal", "workspace"]),
    accountId: v.pipe(v.string(), v.uuid()),
    persistence: v.picklist(["permanent", "expiring"]),
    expiresAt: v.nullable(v.pipe(v.string(), v.maxLength(100))),
    state: v.picklist(["pending", "live"]),
});
const uploadSchema = v.object({
    path: v.pipe(v.string(), v.maxLength(240)),
    method: v.literal("PUT"),
    url: v.pipe(v.string(), v.maxLength(8192)),
    headers: v.record(v.string(), v.string()),
});
const stagedSchema = v.object({
    slug: hereNowSlugSchema,
    isLive: v.boolean(),
    requiresFinalize: v.literal(true),
    publishStatus: ownership,
    upload: v.object({
        versionId: version,
        uploads: v.pipe(v.array(uploadSchema), v.maxLength(8)),
        skipped: v.optional(v.pipe(v.array(v.string()), v.maxLength(8)), []),
    }),
});

/** A changed target that requires a fresh draft instead of a publication retry. */
export class PublicationConflict extends Error {}

/**
 * Publish approved bytes through fixed here.now endpoints and validated presigned storage.
 * No method grants permission; the dispatcher supplies durable admission before each external step.
 */
export class HereNowPublisher {
    private readonly configuration: HereNowReadConfiguration;
    private readonly request: typeof fetch;
    private readonly reader: HereNowReader;
    /**
     * Bind the publishing credential to the same operator-owned immutable account.
     * @param configuration - Explicit executor settings; publishing requires its own configured credential.
     * @param request - HTTP transport, replace only for synthetic tests.
     */
    constructor(configuration: HereNowReadConfiguration, request: typeof fetch = fetch) {
        if (!configuration.publishApiKey)
            throw new Error("Publishing is not provisioned.");
        this.configuration = configuration;
        this.request = request;
        this.reader = new HereNowReader(
            { ...configuration, apiKey: configuration.publishApiKey },
            request
        );
    }
    private async json(
        method: string,
        path: string,
        body: unknown,
        signal: AbortSignal
    ): Promise<unknown> {
        signal.throwIfAborted();
        const response = await this.request(`https://here.now/api/v1/${path}`, {
            method,
            redirect: "error",
            credentials: "omit",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            headers: {
                Authorization: `Bearer ${this.configuration.publishApiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-HereNow-Account": this.configuration.accountId,
                "X-HereNow-Client": "homelab/mira",
            },
            body: JSON.stringify(body),
        });
        return integrationJson(response, 2 * 1024 * 1024);
    }
    /**
     * Verify the write key's account and the explicitly reviewed public update target.
     * @param content - Exact approved files and optional expected live version.
     * @param signal - Bounded preflight cancellation.
     * @returns Completion without writes; a changed target requires a fresh review.
     */
    async preflight(content: MiraPublicationContent, signal: AbortSignal): Promise<void> {
        await this.reader.account(signal);
        if (!content.target) return;
        const site = await this.reader.site(content.target.slug, signal);
        if (
            site.currentVersionId !== content.target.baseVersionId ||
            site.pendingVersionId !== null ||
            site.access.mode !== "anyone_with_link"
        )
            throw new PublicationConflict(
                "The selected site changed, has another pending update or is not public. Read it again and prepare a fresh draft."
            );
    }
    /**
     * Perform one durable approved publication, reporting references before each later step.
     * @param content - Immutable public publication with local file snapshots.
     * @param bytes - Verified file bytes in the same order as the snapshots.
     * @param signal - Shared deadline and service cancellation.
     * @param guard - Revalidate consent, attempt ownership and file availability before each request.
     * @param progress - Persist phase and known provider references without storing presigned credentials.
     * @returns Verified live version; uncertain outcomes are never replayed by this adapter.
     */
    async publish(
        content: MiraPublicationContent,
        bytes: Uint8Array[],
        signal: AbortSignal,
        guard: () => Promise<void>,
        progress: (phase: string, slug: string, versionId: string) => Promise<void>
    ) {
        if (bytes.length !== content.files.length)
            throw new Error("Missing publication bytes.");
        await guard();
        const staged = v.parse(
            stagedSchema,
            await this.json(
                content.target ? "PUT" : "POST",
                content.target
                    ? `publish/${encodeURIComponent(content.target.slug)}`
                    : "publish",
                {
                    files: content.files.map((file) => ({
                        path: file.path,
                        size: file.bytes,
                        contentType: file.mediaType,
                        hash: file.sha256,
                    })),
                    displayName: content.title,
                    ...(content.target
                        ? { baseVersionId: content.target.baseVersionId }
                        : { ttlSeconds: null }),
                },
                signal
            )
        );
        await progress("uploading", staged.slug, staged.upload.versionId);
        if (
            staged.publishStatus.accountId !== this.configuration.accountId ||
            (content.target && staged.slug !== content.target.slug) ||
            (!content.target && staged.isLive)
        )
            throw new Error("Unexpected publication ownership.");
        const requested = content.files.map((file) => file.path);
        const planned = [
            ...staged.upload.uploads.map((upload) => upload.path),
            ...staged.upload.skipped,
        ];
        if (
            planned.length !== requested.length ||
            new Set(planned).size !== planned.length ||
            planned.some((path) => !requested.includes(path))
        )
            throw new Error("The upload manifest differs from the approved files.");
        for (const upload of staged.upload.uploads) {
            const index = requested.indexOf(upload.path);
            const file = content.files[index]!;
            const url = new URL(upload.url);
            if (
                url.protocol !== "https:" ||
                url.username ||
                url.password ||
                url.hash ||
                url.port ||
                !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
                !url.searchParams.get("X-Amz-Signature")
            )
                throw new Error("Unexpected upload destination.");
            const headers = new Headers(upload.headers);
            for (const key of headers.keys())
                if (key !== "content-type") throw new Error("Unexpected upload header.");
            const type = headers.get("content-type") ?? file.mediaType;
            if (
                type.split(";")[0]!.trim().toLowerCase() !==
                file.mediaType.split(";")[0]!.trim().toLowerCase()
            )
                throw new Error("Unexpected upload content type.");
            await guard();
            const response = await this.request(url.href, {
                method: "PUT",
                credentials: "omit",
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                headers: { "Content-Type": type },
                body: Buffer.from(bytes[index]!),
            });
            await response.body?.cancel();
            if (!response.ok) throw new Error("Upload could not be confirmed.");
        }
        await progress("finalizing", staged.slug, staged.upload.versionId);
        await guard();
        const final = v.parse(
            v.object({
                success: v.literal(true),
                slug: hereNowSlugSchema,
                currentVersionId: version,
                unchanged: v.optional(v.boolean(), false),
                publishStatus: ownership,
            }),
            await this.json(
                "POST",
                `publish/${encodeURIComponent(staged.slug)}/finalize`,
                { versionId: staged.upload.versionId },
                signal
            )
        );
        await progress("checking access", final.slug, final.currentVersionId);
        if (
            final.slug !== staged.slug ||
            final.publishStatus.accountId !== this.configuration.accountId ||
            final.publishStatus.state !== "live" ||
            (!final.unchanged && final.currentVersionId !== staged.upload.versionId) ||
            (!content.target &&
                (final.publishStatus.persistence !== "permanent" ||
                    final.publishStatus.expiresAt !== null))
        )
            throw new Error(
                "The live publication differs from the approved destination."
            );
        if (!content.target) {
            await guard();
            await this.json(
                "PATCH",
                `publish/${encodeURIComponent(staged.slug)}/access`,
                {
                    mode: "anyone_with_link",
                    allowedEmails: [],
                    allowedDomains: [],
                    notify: false,
                },
                signal
            );
        }
        await guard();
        const verified = await this.reader.site(staged.slug, signal);
        if (
            verified.currentVersionId !== final.currentVersionId ||
            verified.access.mode !== "anyone_with_link" ||
            verified.manifest.length !== content.files.length ||
            verified.manifestTruncated ||
            content.files.some(
                (file) =>
                    !verified.manifest.some(
                        (item) =>
                            item.path === file.path &&
                            item.size === file.bytes &&
                            (item.hash === undefined || item.hash === file.sha256)
                    )
            )
        )
            throw new Error("The live files or access policy could not be verified.");
        return {
            slug: staged.slug,
            versionId: final.currentVersionId,
            expiresAt: final.publishStatus.expiresAt,
        };
    }
}
