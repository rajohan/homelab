import { expect, test } from "bun:test";

import { readHomelabRelease } from "./read";

const revision = "a".repeat(40);
const manifest = {
    version: "0.8.0",
    revision,
    platform: "linux/amd64",
    images: ["auth", "dashboard"].map((app) => ({
        app,
        reference: `ghcr.io/demo/homelab/${app}:0.8.0@sha256:${"b".repeat(64)}`,
    })),
};
const evidence = {
    name: "release-manifest-1.json",
    expired: false,
    digest: `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
    workflow_run: { id: 100, head_sha: revision },
};

function fixture(
    options: {
        tag?: string;
        manifest?: unknown;
        conclusion?: string;
        redirect?: string;
        artifacts?: unknown[];
        attempt?: number;
    } = {}
) {
    const requests: { url: string; authorization: string | null }[] = [];
    const respond = (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ) => {
        const url = input instanceof Request ? input.url : input.toString();
        requests.push({
            url,
            authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.endsWith("/releases/latest"))
            return Response.json({
                tag_name: "v0.8.0",
                draft: false,
                prerelease: false,
                assets: [{ id: 42, name: "container-images.json" }],
            });
        if (url.endsWith("/releases/assets/42"))
            return new Response(null, {
                status: 302,
                headers: {
                    location:
                        options.redirect ??
                        "https://release-assets.githubusercontent.com/test/manifest",
                },
            });
        if (url.startsWith("https://release-assets.githubusercontent.com/"))
            return Response.json(options.manifest ?? manifest);
        if (url.includes("/git/ref/"))
            return Response.json({
                object: { type: "commit", sha: options.tag ?? revision },
            });
        if (url.includes("/actions/runs?"))
            return Response.json({
                workflow_runs: [
                    {
                        id: 100,
                        run_attempt: options.attempt ?? 1,
                        head_sha: revision,
                        event: "release",
                        path: ".github/workflows/container-images.yml",
                        status: "completed",
                        conclusion: options.conclusion ?? "success",
                    },
                ],
            });
        if (url.includes("/actions/runs/100/artifacts?"))
            return Response.json({ artifacts: options.artifacts ?? [evidence] });
        throw new Error("Unexpected request");
    };
    const request = Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            Promise.resolve(respond(input, init)),
        { preconnect: fetch.preconnect }
    );
    return { request, requests };
}

test("release evidence binds both immutable images to the tag and exact tested commit", async () => {
    const client = fixture();
    const result = await readHomelabRelease(
        "demo/homelab",
        "synthetic-token",
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.verified).toBe(true);
    expect(result.revision).toBe(revision);
    expect(result.images).toHaveLength(2);
    expect(
        client.requests
            .filter((request) => request.url.startsWith("https://api.github.com/"))
            .every((request) => request.authorization === "Bearer synthetic-token")
    ).toBe(true);
    expect(
        client.requests.find((request) =>
            request.url.startsWith("https://release-assets.githubusercontent.com/")
        )?.authorization
    ).toBeNull();
});

test("release reporting refuses changed tags, partial images and off-origin redirects", async () => {
    for (const options of [
        { tag: "c".repeat(40) },
        { manifest: { ...manifest, images: manifest.images.slice(0, 1) } },
        { manifest: { ...manifest, images: [manifest.images[0], manifest.images[0]] } },
        { manifest: { ...manifest, version: "0.9.0" } },
        { redirect: "https://untrusted.example/asset" },
    ]) {
        const client = fixture(options);
        const error = await readHomelabRelease(
            "demo/homelab",
            "synthetic-token",
            AbortSignal.timeout(1000),
            client.request
        ).then(
            () => null,
            (error_: unknown) => error_
        );
        expect(error).toBeInstanceOf(Error);
        expect(
            client.requests.some((request) => request.url.includes("untrusted.example"))
        ).toBe(false);
    }
});

test("a failed release build is reported without claiming the publication is verified", async () => {
    const client = fixture({ conclusion: "failure" });
    const result = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.verified).toBe(false);
    expect(result.tests).toBe("failure");
    expect(client.requests.some(({ url }) => url.includes("/artifacts?"))).toBe(false);
});

test("a replaced manifest cannot borrow successful tests from its tag's earlier build", async () => {
    const client = fixture({
        manifest: {
            ...manifest,
            images: manifest.images.map((image) => ({
                ...image,
                reference: image.reference.replace("b".repeat(64), "c".repeat(64)),
            })),
        },
    });
    const result = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.tests).toBe("success");
    expect(result.verified).toBe(false);
});

test("verification requires unexpired evidence from the exact workflow run and attempt", async () => {
    for (const options of [
        { artifacts: [] },
        { artifacts: [{ ...evidence, expired: true }] },
        { artifacts: [{ ...evidence, digest: null }] },
        { artifacts: [{ ...evidence, workflow_run: { id: 101, head_sha: revision } }] },
        {
            artifacts: [
                { ...evidence, workflow_run: { id: 100, head_sha: "c".repeat(40) } },
            ],
        },
        { artifacts: [evidence, evidence] },
        { attempt: 2 },
    ]) {
        const client = fixture(options);
        const result = await readHomelabRelease(
            "demo/homelab",
            undefined,
            AbortSignal.timeout(1000),
            client.request
        );
        expect(result.verified).toBe(false);
    }
    const client = fixture({
        attempt: 2,
        artifacts: [{ ...evidence, name: "release-manifest-2.json" }],
    });
    const result = await readHomelabRelease(
        "demo/homelab",
        undefined,
        AbortSignal.timeout(1000),
        client.request
    );
    expect(result.verified).toBe(true);
    expect(client.requests.at(-1)?.url).toContain("name=release-manifest-2.json");
});
