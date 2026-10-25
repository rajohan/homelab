import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import {
    miraPublicationInputSchema,
    type MiraPublicationContent,
} from "@homelab/contracts/miraPublication";
import * as v from "valibot";

import { publicationProvider } from "../../testing/herenow";
import { HereNowPublisher } from "./publisher";

const configuration = {
    owner: "operator",
    accountId: "11111111-1111-4111-8111-111111111111",
    apiKey: "synthetic-read-credential",
    publishApiKey: "synthetic-publish-credential",
};
const bytes = new TextEncoder().encode("<h1>Reviewed</h1>");
const content: MiraPublicationContent = {
    title: "Synthetic preview",
    target: null,
    visibility: "anyone_with_link",
    files: [
        {
            id: "22222222-2222-4222-8222-222222222222",
            path: "index.html",
            name: "page.html",
            mediaType: "text/html; charset=utf-8",
            bytes: bytes.length,
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        },
    ],
};
const signal = new AbortController().signal;
const guard = () => Promise.resolve();
const progress = () => Promise.resolve();

test("publication pins account, keeps credentials off storage and verifies the final public files", async () => {
    const provider = publicationProvider(content);
    const publisher = new HereNowPublisher(configuration, provider.request);
    const phases: string[] = [];
    await publisher.preflight(content, signal);
    const result = await publisher.publish(content, [bytes], signal, guard, (phase) => {
        phases.push(phase);
        return Promise.resolve();
    });
    expect(result).toEqual({
        slug: "synthetic-site",
        versionId: "version-new",
        expiresAt: null,
    });
    expect(phases).toEqual(["uploading", "finalizing", "checking access"]);
    expect(provider.state.uploads).toBe(1);
    for (const call of provider.calls) {
        if (call.url.hostname === "here.now") {
            expect(call.headers.get("authorization")).toBe(
                `Bearer ${configuration.publishApiKey}`
            );
            expect(call.headers.get("x-herenow-account")).toBe(configuration.accountId);
        } else {
            expect(call.method).toBe("PUT");
            expect([...call.headers.keys()]).toEqual(["content-type"]);
            expect(call.body).toEqual(Buffer.from(bytes));
        }
        expect(call.url.hostname).not.toBe("untrusted.example");
    }
});

test("updating a public site sends the reviewed base version and preserves its access policy", async () => {
    const update = {
        ...content,
        target: { slug: "owned-site", baseVersionId: "version-old" },
    };
    const provider = publicationProvider(update);
    const publisher = new HereNowPublisher(configuration, provider.request);
    await publisher.preflight(update, signal);
    await publisher.publish(update, [bytes], signal, guard, progress);
    const stage = provider.calls.find(
        (call) => call.url.hostname === "here.now" && call.method === "PUT"
    )!;
    if (typeof stage.body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(stage.body) as unknown).toMatchObject({
        baseVersionId: "version-old",
    });
    expect(provider.calls.some((call) => call.method === "PATCH")).toBe(false);
});

for (const change of ["current", "pending", "access"] as const)
    test(`a changed ${change} requires fresh review before an update`, async () => {
        const update = {
            ...content,
            target: { slug: "owned-site", baseVersionId: "version-old" },
        };
        const provider = publicationProvider(update);
        if (change === "current") provider.state.current = "newer-edit";
        else if (change === "pending") provider.state.pending = "someone-else";
        else provider.state.mode = "restricted";
        await rejects(
            new HereNowPublisher(configuration, provider.request).preflight(
                update,
                signal
            )
        );
        expect(provider.calls.every((call) => call.method === "GET")).toBe(true);
    });

for (const destination of [
    "http://synthetic.r2.cloudflarestorage.com/x",
    "https://attacker.example/x",
    "https://x.r2.cloudflarestorage.com.attacker.example/x",
    "https://user:secret@synthetic.r2.cloudflarestorage.com/x",
    "https://synthetic.r2.cloudflarestorage.com:444/x",
])
    test(`unsafe upload destination is rejected: ${destination}`, async () => {
        const normal = publicationProvider(content);
        const provider = publicationProvider(content, async (call) => {
            if (call.method !== "POST" || call.url.pathname !== "/api/v1/publish") return;
            const response = await normal.request(call.url.href, { method: "POST" });
            const body = (await response.json()) as {
                upload: { uploads: { url: string }[] };
            };
            body.upload.uploads[0]!.url = destination + "?X-Amz-Signature=synthetic";
            return Response.json(body);
        });
        await rejects(
            new HereNowPublisher(configuration, provider.request).publish(
                content,
                [bytes],
                signal,
                guard,
                progress
            )
        );
        expect(provider.calls).toHaveLength(1);
    });

for (const change of ["header", "path", "duplicate", "owner"] as const)
    test(`unapproved provider ${change} is rejected before upload`, async () => {
        const normal = publicationProvider(content);
        const provider = publicationProvider(content, async (call) => {
            if (call.method !== "POST" || call.url.pathname !== "/api/v1/publish") return;
            const response = await normal.request(call.url.href, { method: "POST" });
            const body = (await response.json()) as {
                publishStatus: { accountId: string };
                upload: { uploads: { path: string; headers: Record<string, string> }[] };
            };
            if (change === "header")
                body.upload.uploads[0]!.headers.Authorization = "provider-secret";
            else if (change === "path") body.upload.uploads[0]!.path = "unreviewed.html";
            else if (change === "duplicate")
                body.upload.uploads.push(body.upload.uploads[0]!);
            else body.publishStatus.accountId = "33333333-3333-4333-8333-333333333333";
            return Response.json(body);
        });
        await rejects(
            new HereNowPublisher(configuration, provider.request).publish(
                content,
                [bytes],
                signal,
                guard,
                progress
            )
        );
        expect(provider.calls).toHaveLength(1);
    });

test("failed upload never finalizes and failed final verification never reports success", async () => {
    const failed = publicationProvider(content, (call) =>
        call.method === "PUT" ? new Response("failed", { status: 503 }) : undefined
    );
    await rejects(
        new HereNowPublisher(configuration, failed.request).publish(
            content,
            [bytes],
            signal,
            guard,
            progress
        )
    );
    expect(failed.calls.some((call) => call.url.pathname.endsWith("/finalize"))).toBe(
        false
    );
    const mismatch = publicationProvider(content, (call) =>
        call.url.pathname.endsWith("/access") && call.method === "GET"
            ? Response.json({
                  access: {
                      mode: "restricted",
                      accessPolicyVersion: 2,
                      allowedEmails: [],
                      allowedDomains: [],
                  },
              })
            : undefined
    );
    await rejects(
        new HereNowPublisher(configuration, mismatch.request).publish(
            content,
            [bytes],
            signal,
            guard,
            progress
        )
    );
});

for (const path of [
    "../secret",
    ".herenow/proxy.json",
    "assets/.herenow/data.json",
    "index.html?x=1",
    String.raw`a\b.html`,
    "/index.html",
])
    test(`publication rejects reserved or unsafe path ${path}`, () => {
        expect(
            v.safeParse(miraPublicationInputSchema, {
                ...content,
                files: [{ id: content.files[0]!.id, path }],
            }).success
        ).toBe(false);
    });
