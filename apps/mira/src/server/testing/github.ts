import assert from "node:assert/strict";

import {
    githubPublicationBranch,
    githubTarget,
} from "../integrations/github/configuration";
import type {
    GitHubPublication,
    GitHubPublicationProgress,
    GitHubTreeEntry,
} from "../integrations/github/protocol";
import { GitHubPublisher } from "../integrations/github/publisher";
import { githubBlobHash } from "../integrations/github/repository";
const signal = new AbortController().signal;
export const configuration = {
    owner: "operator",
    token: "synthetic-dedicated-mira-token",
};
const id = "11111111-1111-4111-8111-111111111111";
export const base = "a".repeat(40),
    baseTree = "b".repeat(40),
    newTree = "c".repeat(40),
    createdCommit = "d".repeat(40);
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
export const bytes = encode(plan);
const input: GitHubPublication = {
    id,
    commit: base,
    editsSha256: hash(bytes),
    title: "fix(dashboard): improve display",
    body: "Improve a bounded display behavior. Validation remains recorded separately.",
    authoredAt: "2026-10-25T17:00:00.000Z",
};
const pathPrefix = "/repos/rajohan/homelab";
export type Intercept = (
    url: URL,
    init: RequestInit,
    reply: () => Response
) => Response | Promise<Response>;

/**
 * Simulate fixed GitHub Git-data and PR endpoints without network access or live credentials.
 * @param id - Durable test publication UUID.
 * @param intercept - Optional fault injection around the synthetic response.
 * @returns Request transport, recorded effects and controlled source/ref mutations.
 */
export function githubProvider(id: string, intercept?: Intercept) {
    const branch = githubPublicationBranch(id);
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
            assert.equal(body.base_tree, baseTree);
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
                    assert.equal(modification.sha, null);
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
            assert.equal(body.ref, `refs/heads/${branch}`);
            reference = String(body.sha);
            return Response.json(
                { ref: body.ref, object: { type: "commit", sha: reference } },
                { status: 201 }
            );
        }
        if (route === `${pathPrefix}/pulls` && method === "GET") {
            assert.equal(url.searchParams.get("state"), "all");
            assert.equal(url.searchParams.get("head"), `rajohan:${branch}`);
            assert.equal(url.searchParams.get("base"), "main");
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
            assert.equal(url.origin, "https://api.github.com");
            assert.equal(init.redirect, "error");
            assert.equal(init.credentials, "omit");
            assert.ok(init.signal instanceof AbortSignal);
            assert.equal(
                new Headers(init.headers).get("authorization"),
                `Bearer ${configuration.token}`
            );
            assert.equal(
                new Headers(init.headers).get("x-github-api-version"),
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
        request,
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
        publish: () =>
            client.publish({ ...input, id }, bytes, signal, async () => {}, progress),
    };
}
