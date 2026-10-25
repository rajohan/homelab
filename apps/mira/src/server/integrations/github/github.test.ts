import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import {
    githubBinding,
    githubBindingHash,
    githubConfiguration,
    githubPublicationBranch,
    githubTarget,
} from "./configuration";
import {
    type GitHubPublication,
    type GitHubPublicationProgress,
    type GitHubTreeEntry,
} from "./protocol";
import { GitHubMutationUncertain, GitHubPublisher } from "./publisher";
import { GitHubClient, githubBlobHash } from "./repository";

const signal = new AbortController().signal;
const configuration = { owner: "operator", token: "synthetic-dedicated-mira-token" };
const id = "11111111-1111-4111-8111-111111111111";
const base = "a".repeat(40),
    baseTree = "b".repeat(40),
    newTree = "c".repeat(40),
    createdCommit = "d".repeat(40);
const branch = githubPublicationBranch(id);
const hash = (text: string | Uint8Array) =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex");
const original = "before\n";
const plan = {
    version: 1,
    commit: base,
    files: [
        { path: "src/app.ts", beforeSha256: hash(original), content: "after\n" },
        { path: "empty.txt", beforeSha256: hash(""), content: null },
        { path: "new.txt", beforeSha256: null, content: "\uFEFFnew æ\r\n" },
    ],
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const bytes = encode(plan);
const input: GitHubPublication = {
    id,
    commit: base,
    editsSha256: hash(bytes),
    title: "fix(dashboard): improve display",
    body: "Improve a bounded display behavior. Validation remains recorded separately.",
    authoredAt: "2026-10-25T17:00:00.000Z",
};
const pathPrefix = "/repos/rajohan/homelab";
type Intercept = (
    url: URL,
    init: RequestInit,
    reply: () => Response
) => Response | Promise<Response>;

function fixture(intercept?: Intercept) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const events: GitHubPublicationProgress[] = [];
    const source = new Map([
        ["src/app.ts", original],
        ["empty.txt", ""],
        ["keep.txt", "unchanged\n"],
    ]);
    const entries: GitHubTreeEntry[] = [...source].map(([path, content]) => ({
        path,
        mode: path === "src/app.ts" ? "100755" : "100644",
        type: "blob",
        sha: githubBlobHash(Buffer.from(content)),
        size: Buffer.byteLength(content),
    }));
    entries.push({ path: "src", mode: "040000", type: "tree", sha: "e".repeat(40) });
    let changed = entries.map((entry) => ({ ...entry }));
    let main = base;
    let reference: string | null = null;
    let commit: unknown = null;
    let pull: unknown = null;
    function reply(url: URL, init: RequestInit): Response {
        const method = init.method,
            route = url.pathname;
        if (init.body !== undefined && typeof init.body !== "string")
            throw new Error("Expected JSON text body.");
        const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        if (route === "/user")
            return Response.json({
                login: githubTarget.login,
                id: githubTarget.accountId,
                type: "User",
            });
        if (route === pathPrefix)
            return Response.json({
                id: githubTarget.repositoryId,
                full_name: githubTarget.repository,
                private: false,
                archived: false,
                disabled: false,
                default_branch: "main",
                permissions: { push: true },
            });
        if (route === `${pathPrefix}/git/ref/heads/main`)
            return Response.json({
                ref: "refs/heads/main",
                object: { type: "commit", sha: main },
            });
        if (route === `${pathPrefix}/git/ref/heads/${encodeURIComponent(branch)}`)
            return reference
                ? Response.json({
                      ref: `refs/heads/${branch}`,
                      object: { type: "commit", sha: reference },
                  })
                : new Response("missing", { status: 404 });
        if (route === `${pathPrefix}/git/commits/${base}`)
            return Response.json({ sha: base, tree: { sha: baseTree } });
        if (route === `${pathPrefix}/git/commits/${createdCommit}`)
            return Response.json(commit);
        if (route === `${pathPrefix}/git/trees/${baseTree}`)
            return Response.json({ sha: baseTree, truncated: false, tree: entries });
        if (route === `${pathPrefix}/git/trees/${newTree}`)
            return Response.json({ sha: newTree, truncated: false, tree: changed });
        if (route.startsWith(`${pathPrefix}/git/blobs/`)) {
            const content = [...source.values()].find((text) =>
                route.endsWith(githubBlobHash(Buffer.from(text)))
            );
            if (content === undefined) throw new Error("Unexpected blob request.");
            return Response.json({
                sha: githubBlobHash(Buffer.from(content)),
                encoding: "base64",
                size: Buffer.byteLength(content),
                content: Buffer.from(content).toString("base64") + "\n",
            });
        }
        if (route === `${pathPrefix}/git/trees` && method === "POST") {
            expect(body.base_tree).toBe(baseTree);
            const modifications = body.tree as {
                path: string;
                mode: "100644" | "100755";
                type: "blob";
                content?: string;
                sha?: null;
            }[];
            for (const modification of modifications) {
                changed = changed.filter((entry) => entry.path !== modification.path);
                if (modification.content === undefined)
                    expect(modification.sha).toBeNull();
                else
                    changed.push({
                        path: modification.path,
                        mode: modification.mode,
                        type: "blob",
                        sha: githubBlobHash(Buffer.from(modification.content)),
                        size: Buffer.byteLength(modification.content),
                    });
            }
            return Response.json({ sha: newTree }, { status: 201 });
        }
        if (route === `${pathPrefix}/git/commits` && method === "POST") {
            commit = {
                ...body,
                sha: createdCommit,
                tree: { sha: body.tree },
                parents: (body.parents as string[]).map((sha) => ({ sha })),
            };
            return Response.json(commit, { status: 201 });
        }
        if (route === `${pathPrefix}/git/refs` && method === "POST") {
            if (reference) return new Response("already exists", { status: 422 });
            expect(body.ref).toBe(`refs/heads/${branch}`);
            reference = String(body.sha);
            return Response.json(
                { ref: body.ref, object: { type: "commit", sha: reference } },
                { status: 201 }
            );
        }
        if (route === `${pathPrefix}/pulls` && method === "GET") {
            expect(url.searchParams.get("state")).toBe("all");
            expect(url.searchParams.get("head")).toBe(`rajohan:${branch}`);
            expect(url.searchParams.get("base")).toBe("main");
            return Response.json(pull ? [pull] : []);
        }
        if (route === `${pathPrefix}/pulls` && method === "POST") {
            const repo = {
                id: githubTarget.repositoryId,
                full_name: githubTarget.repository,
            };
            pull = {
                number: 123,
                html_url: "https://github.com/rajohan/homelab/pull/123",
                state: "open",
                draft: body.draft,
                title: body.title,
                body: body.body,
                user: { login: githubTarget.login, id: githubTarget.accountId },
                head: { ref: branch, sha: reference, repo },
                base: { ref: "main", sha: main, repo },
            };
            return Response.json(pull, { status: 201 });
        }
        throw new Error(`Unexpected synthetic GitHub request: ${method} ${route}`);
    }
    const request = Object.assign(
        async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (typeof target !== "string" || !init)
                throw new Error("Expected explicit transport.");
            const url = new URL(target);
            expect(url.origin).toBe("https://api.github.com");
            expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(new Headers(init.headers).get("authorization")).toBe(
                `Bearer ${configuration.token}`
            );
            expect(new Headers(init.headers).get("x-github-api-version")).toBe(
                githubTarget.apiVersion
            );
            calls.push({ url, init });
            return intercept
                ? intercept(url, init, () => reply(url, init))
                : reply(url, init);
        },
        { preconnect: fetch.preconnect }
    );
    const client = new GitHubPublisher(configuration, request);
    const progress = (event: GitHubPublicationProgress) => {
        events.push(event);
        return Promise.resolve();
    };
    return {
        client,
        calls,
        events,
        progress,
        entries,
        setMain: (sha: string) => {
            main = sha;
        },
        setReference: (sha: string) => {
            reference = sha;
        },
        publish: () => client.publish(input, bytes, signal, async () => {}, progress),
    };
}

test("GitHub configuration fixes Mira and Homelab independently of ambient credentials", () => {
    expect(
        githubConfiguration({ GH_TOKEN: "unrelated", GITHUB_TOKEN: "other" })
    ).toBeUndefined();
    expect(githubBinding({})).toBeUndefined();
    expect(
        githubConfiguration({
            HOMELAB_MIRA_GITHUB_OWNER: "operator",
            HOMELAB_MIRA_GITHUB_TOKEN: configuration.token,
        })
    ).toEqual(configuration);
    expect(() =>
        githubConfiguration({ HOMELAB_MIRA_GITHUB_TOKEN: configuration.token })
    ).toThrow();
    expect(() => githubBinding({ HOMELAB_MIRA_GITHUB_OWNER: "bad owner" })).toThrow();
    expect(() => new GitHubClient({ owner: "operator", token: "\nsecret" })).toThrow(
        "dedicated credential"
    );
    expect(githubBindingHash({ owner: "operator" })).not.toBe(
        githubBindingHash({ owner: "another" })
    );
    expect(githubBindingHash(configuration)).toBe(
        githubBindingHash({ owner: configuration.owner })
    );
    const rotated = { ...configuration, token: "another-synthetic-credential" };
    expect(githubBindingHash(rotated)).toBe(githubBindingHash(configuration));
    expect(githubPublicationBranch(id)).toBe(`mira/publication/${id}`);
    expect(() => githubPublicationBranch("main")).toThrow();
});

test("publication verifies source bytes and unchanged files then creates a Mira-authored draft without updating refs", async () => {
    const f = fixture();
    expect(await f.publish()).toEqual({
        number: 123,
        url: "https://github.com/rajohan/homelab/pull/123",
        branch,
        commit: createdCommit,
        tree: newTree,
        base,
        draft: true,
    });
    const writes = f.calls.filter((call) => call.init.method !== "GET");
    expect(writes.map((call) => [call.init.method, call.url.pathname])).toEqual([
        ...["trees", "commits", "refs"].map((name) => [
            "POST",
            `${pathPrefix}/git/${name}`,
        ]),
        ["POST", `${pathPrefix}/pulls`],
    ]);
    const created = JSON.parse(writes[1]!.init.body as string) as unknown;
    expect(created).toMatchObject({
        author: { name: "Mira", email: "mira-2026@agentmail.to" },
        committer: { name: "Mira", email: "mira-2026@agentmail.to" },
        parents: [base],
        tree: newTree,
    });
    expect(writes[3]!.init.body as string).not.toContain(configuration.token);
    expect(f.events.map((event) => `${event.phase}:${event.state}`)).toEqual([
        "tree:sending",
        "tree:confirmed",
        "commit:sending",
        "commit:confirmed",
        "branch:sending",
        "branch:confirmed",
        "pull_request:sending",
        "pull_request:confirmed",
    ]);
    const after = f.calls.length;
    expect(await f.client.inspectPublication(id, signal)).toMatchObject({
        branchSha: createdCommit,
        pullRequest: { number: 123, draft: true, commit: createdCommit },
    });
    expect(f.calls.slice(after).every((call) => call.init.method === "GET")).toBe(true);
    await rejects(f.publish(), /already has a branch/);
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(4);
});

test.each([
    "account",
    "login",
    "repository",
    "private",
    "permission",
    "main",
    "reference",
    "blob",
    "fingerprint",
    "truncated",
    "symlink",
    "parent",
])("publication fails before any writes for invalid %s", async (mode) => {
    const f = fixture(async (url, _init, reply) => {
        const response = reply();
        if (!response.ok) return response;
        const value = (await response.json()) as Record<string, unknown>;
        if (url.pathname === "/user") {
            if (mode === "account") value.id = 1;
            if (mode === "login") value.login = "rajohan";
        }
        if (url.pathname === pathPrefix) {
            if (mode === "repository") value.id = 2;
            if (mode === "private") value.private = true;
            if (mode === "permission") value.permissions = { push: false };
        }
        if (url.pathname.endsWith(`/git/trees/${baseTree}`)) {
            if (mode === "truncated") value.truncated = true;
            if (mode === "symlink")
                value.tree = f.entries.map((entry) =>
                    entry.path === "src/app.ts" ? { ...entry, mode: "120000" } : entry
                );
            if (mode === "parent")
                value.tree = f.entries.map((entry) =>
                    entry.path === "src"
                        ? { ...entry, mode: "120000", type: "blob" }
                        : entry
                );
        }
        if (url.pathname.includes("/git/blobs/") && mode === "blob")
            value.content = Buffer.from("tampered").toString("base64");
        return Response.json(value, { status: response.status });
    });
    if (mode === "main") f.setMain("f".repeat(40));
    if (mode === "reference") f.setReference(createdCommit);
    const selected =
        mode === "fingerprint"
            ? encode({
                  ...plan,
                  files: [{ ...plan.files[0], beforeSha256: hash("wrong") }],
              })
            : bytes;
    await rejects(
        f.client.publish(
            { ...input, editsSha256: hash(selected) },
            selected,
            signal,
            async () => {},
            f.progress
        )
    );
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
});

test.each(["tree", "commit", "branch", "pull_request"] as const)(
    "uncertain %s write is never replayed and can be inspected read-only",
    async (phase) => {
        const endpoints = {
            tree: `${pathPrefix}/git/trees`,
            commit: `${pathPrefix}/git/commits`,
            branch: `${pathPrefix}/git/refs`,
            pull_request: `${pathPrefix}/pulls`,
        };
        const f = fixture((url, init, reply) => {
            const response = reply();
            if (init.method === "POST" && url.pathname === endpoints[phase])
                throw new Error("Synthetic response lost with private diagnostic");
            return response;
        });
        await rejects(
            f.publish(),
            (error: unknown) =>
                error instanceof GitHubMutationUncertain &&
                error.phase === phase &&
                !error.message.includes("private diagnostic")
        );
        const count = f.calls.filter((call) => call.init.method === "POST").length;
        expect(count).toBe(
            ["tree", "commit", "branch", "pull_request"].indexOf(phase) + 1
        );
        const observed = await f.client.inspectPublication(id, signal);
        expect(observed.branchSha).toBe(
            ["branch", "pull_request"].includes(phase) ? createdCommit : null
        );
        expect(observed.pullRequest?.number ?? null).toBe(
            phase === "pull_request" ? 123 : null
        );
        expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(count);
    }
);

test.each(["tree", "commit", "branch", "pull_request"] as const)(
    "fresh consent guard stops before %s even after the durable sending marker",
    async (phase) => {
        const f = fixture();
        let revoked = false;
        await rejects(
            f.client.publish(
                input,
                bytes,
                signal,
                () => {
                    if (revoked) throw new Error("consent revoked");
                    return Promise.resolve();
                },
                (event) => {
                    f.events.push(event);
                    if (event.phase === phase && event.state === "sending")
                        revoked = true;
                    return Promise.resolve();
                }
            ),
            /consent revoked/
        );
        expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(
            ["tree", "commit", "branch", "pull_request"].indexOf(phase)
        );
    }
);

test("each write rechecks Mira identity and commit authorship is verified separately", async () => {
    let wrote = false;
    const f = fixture((url, init, reply) => {
        if (init.method === "POST") wrote = true;
        if (url.pathname === "/user" && wrote)
            return Response.json({ login: "rajohan", id: 1, type: "User" });
        return reply();
    });
    await rejects(f.publish());
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    const altered = fixture(async (url, init, reply) => {
        const response = reply();
        if (url.pathname === `${pathPrefix}/git/commits` && init.method === "POST") {
            const value = (await response.json()) as Record<string, unknown>;
            return Response.json(
                {
                    ...value,
                    author: {
                        name: "Raymond",
                        email: "unexpected@example.invalid",
                        date: input.authoredAt,
                    },
                },
                { status: 201 }
            );
        }
        return response;
    });
    await rejects(
        altered.publish(),
        (error: unknown) =>
            error instanceof GitHubMutationUncertain && error.phase === "commit"
    );
    expect(altered.calls.filter((call) => call.init.method === "POST")).toHaveLength(2);
});

test("unexpected tree changes and confirmation receipt failures stop before a branch is published", async () => {
    const f = fixture(async (url, _init, reply) => {
        const response = reply();
        if (url.pathname.endsWith(`/git/trees/${newTree}`)) {
            const value = (await response.json()) as { tree: GitHubTreeEntry[] };
            value.tree = value.tree.filter((entry) => entry.path !== "keep.txt");
            return Response.json(value);
        }
        return response;
    });
    await rejects(
        f.publish(),
        (error: unknown) =>
            error instanceof GitHubMutationUncertain && error.phase === "tree"
    );
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    const receipts = fixture();
    await rejects(
        receipts.client.publish(
            input,
            bytes,
            signal,
            async () => {},
            (event) => {
                if (event.state === "confirmed")
                    throw new Error("database receipt failed");
                return Promise.resolve();
            }
        ),
        (error: unknown) => error instanceof GitHubMutationUncertain
    );
    expect(receipts.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
});

test("cancellation and changed selected bytes prevent transport or the next mutation", async () => {
    const f = fixture(),
        controller = new AbortController();
    controller.abort();
    await rejects(
        f.client.publish(input, bytes, controller.signal, async () => {}, f.progress)
    );
    expect(f.calls).toHaveLength(0);
    await rejects(
        f.client.publish(
            { ...input, editsSha256: hash("changed") },
            bytes,
            signal,
            async () => {},
            f.progress
        ),
        /approved digest/
    );
    expect(f.calls).toHaveLength(0);
    const active = new AbortController();
    await rejects(
        f.client.publish(
            input,
            bytes,
            active.signal,
            async () => {},
            (event) => {
                if (event.state === "sending") active.abort();
                return Promise.resolve();
            }
        )
    );
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
});

test("main advancing during preparation leaves immutable objects without creating a branch", async () => {
    const f = fixture();
    await rejects(
        f.client.publish(
            input,
            bytes,
            signal,
            async () => {},
            (event) => {
                if (event.phase === "commit" && event.state === "confirmed")
                    f.setMain("f".repeat(40));
                return Promise.resolve();
            }
        ),
        /Main changed/
    );
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(2);
    expect(await f.client.inspectPublication(id, signal)).toMatchObject({
        branchSha: null,
        pullRequest: null,
    });
});

test.each([302, 401, 403, 429, 500])(
    "GitHub rejects status %s without exposing provider error bodies",
    async (status) => {
        const f = fixture(() => new Response("private-token-diagnostic", { status }));
        await rejects(
            f.publish(),
            (error: unknown) =>
                error instanceof Error &&
                !error.message.includes("private-token-diagnostic")
        );
        expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
    }
);

test.each([
    { title: "fix: first\nsecond" },
    { title: "fix: " + "x".repeat(160) },
    { body: "\uD800" },
    { body: "x".repeat(16_001) },
    { authoredAt: "2026-02-31T17:00:00.000Z" },
    { authoredAt: "2026-10-25T17:00:00.001Z" },
])("invalid publication metadata fails without transport: %j", async (change) => {
    const f = fixture();
    await rejects(
        f.client.publish(
            { ...input, ...change },
            bytes,
            signal,
            async () => {},
            f.progress
        )
    );
    expect(f.calls).toHaveLength(0);
});

test.each(["invalid-json", "oversized-body", "oversized-header", "empty"])(
    "bounded provider parsing rejects %s before publication",
    async (mode) => {
        const f = fixture(() => {
            if (mode === "oversized-header")
                return new Response("private", {
                    headers: { "content-length": "4194305" },
                });
            if (mode === "oversized-body") return new Response("x".repeat(4_194_305));
            if (mode === "empty") return new Response(null);
            return new Response("invalid-private-diagnostic");
        });
        await rejects(
            f.publish(),
            (error: unknown) =>
                error instanceof Error && !error.message.includes("private-diagnostic")
        );
        expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
    }
);

test.each([
    "duplicate-tree",
    "tree-sha",
    "mode-type",
    "base-sha",
    "blob-size",
    "blob-sha",
    "blob-base64",
    "original-size",
    "original-missing",
])("malformed original %s cannot reach a write", async (mode) => {
    const f = fixture(async (url, _init, reply) => {
        const response = reply();
        if (!response.ok) return response;
        const value = (await response.json()) as Record<string, unknown>;
        if (url.pathname.endsWith(`/git/commits/${base}`) && mode === "base-sha")
            value.sha = newTree;
        if (url.pathname.endsWith(`/git/trees/${baseTree}`)) {
            if (mode === "tree-sha") value.sha = newTree;
            if (mode === "duplicate-tree") value.tree = [...f.entries, f.entries[0]];
            if (mode === "mode-type")
                value.tree = f.entries.map((entry) =>
                    entry.path === "src/app.ts" ? { ...entry, type: "commit" } : entry
                );
            if (mode === "original-size")
                value.tree = f.entries.map((entry) =>
                    entry.path === "src/app.ts" ? { ...entry, size: 262_145 } : entry
                );
            if (mode === "original-missing")
                value.tree = f.entries.filter((entry) => entry.path !== "src/app.ts");
        }
        if (url.pathname.includes("/git/blobs/")) {
            if (mode === "blob-size") value.size = 1;
            if (mode === "blob-sha") value.sha = base;
            if (mode === "blob-base64") value.content = "@@invalid@@";
        }
        return Response.json(value, { status: response.status });
    });
    await rejects(f.publish());
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
});

test.each([
    { path: "src/app.ts", beforeSha256: null, content: "new" },
    { path: "absent.txt", beforeSha256: null, content: null },
    { path: "src/app.ts", beforeSha256: hash(original), content: original },
    { path: "../escape", beforeSha256: null, content: "new" },
    { path: ".git/config", beforeSha256: null, content: "new" },
])("invalid selected file %j is rejected before writes", async (file) => {
    const f = fixture(),
        selected = encode({ ...plan, files: [file] });
    await rejects(
        f.client.publish(
            { ...input, editsSha256: hash(selected) },
            selected,
            signal,
            async () => {},
            f.progress
        )
    );
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
});

test.each([
    "branch-response",
    "branch-readback",
    "pr-owner",
    "pr-url",
    "pr-base",
    "pr-draft",
    "pr-body",
])(
    "unexpected publication result %s remains uncertain without further writes",
    async (mode) => {
        let wroteBranch = false;
        const f = fixture(async (url, init, reply) => {
            const response = reply();
            if (!response.ok) return response;
            const value = (await response.json()) as Record<string, unknown>;
            if (init.method === "POST" && url.pathname.endsWith("/git/refs")) {
                wroteBranch = true;
                if (mode === "branch-response") value.ref = "refs/heads/main";
            }
            if (
                mode === "branch-readback" &&
                wroteBranch &&
                url.pathname.includes("/git/ref/heads/")
            )
                value.object = { type: "commit", sha: base };
            if (init.method === "POST" && url.pathname.endsWith("/pulls")) {
                if (mode === "pr-owner") value.user = { login: "rajohan", id: 1 };
                if (mode === "pr-url") value.html_url = "https://example.invalid/private";
                if (mode === "pr-base")
                    value.base = { ...(value.base as object), sha: newTree };
                if (mode === "pr-draft") value.draft = false;
                if (mode === "pr-body") value.body = "unreviewed text";
            }
            return Response.json(value, { status: response.status });
        });
        await rejects(
            f.publish(),
            (error: unknown) =>
                error instanceof GitHubMutationUncertain &&
                error.phase === (mode.startsWith("branch") ? "branch" : "pull_request")
        );
        expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(
            mode.startsWith("branch") ? 3 : 4
        );
    }
);

test("reconciliation refuses ambiguous pull requests and never retries publication", async () => {
    let ambiguous = false;
    const f = fixture(async (url, init, reply) => {
        const response = reply();
        if (ambiguous && init.method === "GET" && url.pathname.endsWith("/pulls")) {
            const rows = (await response.json()) as unknown[];
            return Response.json([rows[0], rows[0]]);
        }
        return response;
    });
    await f.publish();
    ambiguous = true;
    await rejects(f.client.inspectPublication(id, signal), /ambiguous/);
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(4);
});

test("branch changes between verified creation and PR submission require a new proposal", async () => {
    const f = fixture();
    await rejects(
        f.client.publish(
            input,
            bytes,
            signal,
            async () => {},
            (event) => {
                if (event.phase === "branch" && event.state === "confirmed")
                    f.setReference(base);
                return Promise.resolve();
            }
        ),
        /branch changed/
    );
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(3);
});
