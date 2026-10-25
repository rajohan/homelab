import type { MiraPublicationContent } from "@homelab/contracts/miraPublication";

export interface HereNowCall {
    url: URL;
    method: string;
    headers: Headers;
    body: NonNullable<Parameters<typeof fetch>[1]>["body"];
}
/**
 * Simulate the fixed account, presigned upload and publication API using synthetic data.
 * @param content - Exact expected publication snapshots; no file or account is read externally.
 * @param before - Optional transport hook for failures, races and malformed response qualification.
 * @returns In-memory provider state, recorded calls and a fetch-compatible transport.
 */
export function publicationProvider(
    content: MiraPublicationContent,
    before?: (call: HereNowCall) => Promise<Response | void> | Response | void
) {
    const accountId = "11111111-1111-4111-8111-111111111111";
    const slug = content.target?.slug ?? "synthetic-site";
    const state = {
        current: content.target?.baseVersionId ?? null,
        pending: null as string | null,
        mode: "anyone_with_link",
        uploads: 0,
    };
    const calls: HereNowCall[] = [];
    const status = (live: boolean) => ({
        requestAuth: "api_key",
        ownership: "personal",
        accountId,
        persistence: "permanent",
        expiresAt: null,
        state: live ? "live" : "pending",
    });
    const request = Object.assign(
        async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
        ) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const call = {
                url,
                method: init?.method ?? "GET",
                headers: new Headers(init?.headers),
                body: init?.body,
            };
            calls.push(call);
            const override = await before?.(call);
            if (override) return override;
            if (url.hostname.endsWith(".r2.cloudflarestorage.com")) {
                state.uploads++;
                return new Response(null, { status: 200 });
            }
            if (url.pathname.endsWith("/accounts"))
                return Response.json({
                    currentAccountId: accountId,
                    accounts: [
                        {
                            accountId,
                            type: "personal",
                            displayName: "Synthetic",
                            status: "active",
                            provisioningStatus: "active",
                            role: "admin",
                        },
                    ],
                });
            if (url.pathname.endsWith("/access")) {
                if (call.method === "PATCH") state.mode = "anyone_with_link";
                return Response.json({
                    access: {
                        mode: state.mode,
                        accessPolicyVersion: 1,
                        allowedEmails: [],
                        allowedDomains: [],
                    },
                });
            }
            if (url.pathname.endsWith("/finalize")) {
                state.current = state.pending;
                state.pending = null;
                return Response.json({
                    success: true,
                    slug,
                    currentVersionId: state.current,
                    publishStatus: status(true),
                });
            }
            if (call.method === "POST" || call.method === "PUT") {
                state.pending = "version-new";
                return Response.json({
                    slug,
                    isLive: Boolean(state.current),
                    requiresFinalize: true,
                    publishStatus: status(false),
                    upload: {
                        versionId: state.pending,
                        uploads: content.files.map((file) => ({
                            path: file.path,
                            method: "PUT",
                            url: `https://synthetic.r2.cloudflarestorage.com/${file.path}?X-Amz-Signature=${"a".repeat(64)}`,
                            headers: { "Content-Type": file.mediaType },
                        })),
                        skipped: [],
                        finalizeUrl: `https://untrusted.example/finalize`,
                        expiresInSeconds: 900,
                    },
                });
            }
            if (url.pathname === `/api/v1/publish/${slug}`)
                return Response.json({
                    slug,
                    status: "active",
                    currentVersionId: state.current,
                    pendingVersionId: state.pending,
                    updatedAt: "2026-10-25T00:00:00Z",
                    expiresAt: null,
                    currentVersionSource: "publish-finalize",
                    currentVersionCreatedAt: "2026-10-25T00:00:00Z",
                    manifest: content.files.map((file) => ({
                        path: file.path,
                        size: file.bytes,
                        contentType: file.mediaType,
                        hash: file.sha256,
                    })),
                });
            throw new Error("Unexpected synthetic request.");
        },
        { preconnect: fetch.preconnect }
    );
    return { request, calls, state };
}
