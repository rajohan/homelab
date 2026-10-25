import * as v from "valibot";

import { decodeSandboxText, type SandboxEditPlan } from "../../sandbox/edits";
import { integrationJson } from "../http";
import {
    githubConfiguration,
    githubPublicationBranch,
    githubTarget,
    type GitHubConfiguration,
} from "./configuration";
import {
    gitShaSchema,
    pullSchema,
    referenceSchema,
    sourceCommitSchema,
    treeSchema,
    type GitHubPullRequest,
    type GitHubTreeEntry,
} from "./protocol";

export const githubRepositoryPath = `/repos/${githubTarget.repository}`;

/** A changed source or destination requires a new proposal, never a forced reference update. */
export class GitHubPublicationConflict extends Error {}

/**
 * Compute the Git blob identity from exact UTF-8 bytes without invoking Git or repository code.
 * @param bytes - Bounded file bytes.
 * @returns SHA-1 of the canonical blob object, including its byte-length header.
 */
export function githubBlobHash(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
}

/** Fixed-origin, fixed-account repository access; no host checkout, CLI discovery or model credentials. */
export class GitHubClient {
    private readonly configuration: Readonly<GitHubConfiguration>;
    private readonly request: typeof fetch;
    /**
     * Bind an explicit dedicated credential to the fixed Mira identity and Homelab repository.
     * @param configuration - Service-owned operator mapping and token; never exposed to models.
     * @param request - Transport replacement for synthetic qualification only.
     */
    constructor(configuration: GitHubConfiguration, request: typeof fetch = fetch) {
        const parsed = githubConfiguration({
            HOMELAB_MIRA_GITHUB_OWNER: configuration.owner,
            HOMELAB_MIRA_GITHUB_TOKEN: configuration.token,
        });
        if (!parsed) throw new Error("GitHub publication is not provisioned.");
        this.configuration = Object.freeze({ ...parsed });
        this.request = request;
    }
    protected async json(
        method: "GET" | "POST",
        route: string,
        signal: AbortSignal,
        body?: unknown,
        missing = false
    ): Promise<unknown> {
        signal.throwIfAborted();
        if (
            route !== "/user" &&
            route !== githubRepositoryPath &&
            !route.startsWith(`${githubRepositoryPath}/`)
        )
            throw new Error("Unexpected GitHub route.");
        const response = await this.request(`https://api.github.com${route}`, {
            method,
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            headers: {
                Authorization: `Bearer ${this.configuration.token}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": githubTarget.apiVersion,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (missing && method === "GET" && response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        if (response.status !== (method === "POST" ? 201 : 200)) {
            await response.body?.cancel();
            throw new Error("GitHub did not confirm the expected response.");
        }
        return integrationJson(response, 4 * 1024 * 1024);
    }
    protected async verifyBinding(signal: AbortSignal): Promise<void> {
        v.parse(
            v.object({
                login: v.literal(githubTarget.login),
                id: v.literal(githubTarget.accountId),
                type: v.literal("User"),
            }),
            await this.json("GET", "/user", signal)
        );
        v.parse(
            v.object({
                id: v.literal(githubTarget.repositoryId),
                full_name: v.literal(githubTarget.repository),
                private: v.literal(false),
                archived: v.literal(false),
                disabled: v.literal(false),
                default_branch: v.literal(githubTarget.branch),
                permissions: v.object({ push: v.literal(true) }),
            }),
            await this.json("GET", githubRepositoryPath, signal)
        );
    }
    protected async reference(
        branch: string,
        signal: AbortSignal,
        missing = false
    ): Promise<string | null> {
        const raw = await this.json(
            "GET",
            `${githubRepositoryPath}/git/ref/heads/${encodeURIComponent(branch)}`,
            signal,
            undefined,
            missing
        );
        if (raw === null && missing) return null;
        const result = v.parse(referenceSchema, raw);
        if (result.ref !== `refs/heads/${branch}`)
            throw new Error("GitHub returned a different reference.");
        return result.object.sha;
    }
    protected async requireBase(commit: string, signal: AbortSignal): Promise<void> {
        if ((await this.reference(githubTarget.branch, signal)) !== commit)
            throw new GitHubPublicationConflict(
                "Main changed. Inspect the current source and prepare a fresh proposal."
            );
    }
    protected async tree(sha: string, signal: AbortSignal): Promise<GitHubTreeEntry[]> {
        const parsed = v.parse(
            treeSchema,
            await this.json(
                "GET",
                `${githubRepositoryPath}/git/trees/${v.parse(gitShaSchema, sha)}?recursive=1`,
                signal
            )
        );
        if (
            parsed.sha !== sha ||
            new Set(parsed.tree.map((entry) => entry.path)).size !== parsed.tree.length
        )
            throw new Error("GitHub tree identity or paths could not be verified.");
        for (const entry of parsed.tree) {
            const types = {
                "040000": "tree",
                "160000": "commit",
                "100644": "blob",
                "100755": "blob",
                "120000": "blob",
            } as const;
            const type = types[entry.mode];
            if (entry.type !== type)
                throw new Error("GitHub tree modes could not be verified.");
        }
        return parsed.tree;
    }
    protected async prepare(plan: SandboxEditPlan, signal: AbortSignal) {
        await this.verifyBinding(signal);
        await this.requireBase(plan.commit, signal);
        const commit = v.parse(
            sourceCommitSchema,
            await this.json(
                "GET",
                `${githubRepositoryPath}/git/commits/${plan.commit}`,
                signal
            )
        );
        if (commit.sha !== plan.commit)
            throw new Error("GitHub returned a different base commit.");
        const entries = await this.tree(commit.tree.sha, signal);
        const indexed = new Map(entries.map((entry) => [entry.path, entry]));
        const expected = new Map(
            entries
                .filter((entry) => entry.type !== "tree")
                .map((entry) => [entry.path, entry])
        );
        const changes: {
            path: string;
            mode: "100644" | "100755";
            type: "blob";
            content?: string;
            sha?: null;
        }[] = [];
        for (const file of plan.files) {
            signal.throwIfAborted();
            const parts = file.path.split("/");
            for (let i = 1; i < parts.length; i++) {
                const parent = indexed.get(parts.slice(0, i).join("/"));
                if (parent && parent.type !== "tree")
                    throw new GitHubPublicationConflict(
                        "A selected path traverses a non-directory entry."
                    );
            }
            const previous = indexed.get(file.path);
            let mode: "100644" | "100755" = "100644";
            if (file.beforeSha256 === null) {
                if (previous || file.content === null)
                    throw new GitHubPublicationConflict(
                        "A new file already exists or has no content."
                    );
            } else {
                if (
                    !previous ||
                    previous.type !== "blob" ||
                    !["100644", "100755"].includes(previous.mode) ||
                    previous.size === undefined ||
                    previous.size > 262_144
                )
                    throw new GitHubPublicationConflict(
                        "The original is missing, special or exceeds the text limit."
                    );
                mode = previous.mode as "100644" | "100755";
                const blob = v.parse(
                    v.object({
                        sha: gitShaSchema,
                        encoding: v.literal("base64"),
                        size: v.pipe(
                            v.number(),
                            v.integer(),
                            v.minValue(0),
                            v.maxValue(262_144)
                        ),
                        content: v.pipe(v.string(), v.maxLength(400_000)),
                    }),
                    await this.json(
                        "GET",
                        `${githubRepositoryPath}/git/blobs/${previous.sha}`,
                        signal
                    )
                );
                const encoded = blob.content.replaceAll("\n", "").replaceAll("\r", "");
                const bytes = Buffer.from(encoded, "base64");
                if (
                    bytes.toString("base64") !== encoded ||
                    blob.sha !== previous.sha ||
                    bytes.length !== blob.size ||
                    blob.size !== previous.size ||
                    githubBlobHash(bytes) !== previous.sha
                )
                    throw new Error("Original Git blob bytes could not be verified.");
                const original = decodeSandboxText(bytes);
                if (
                    new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !==
                    file.beforeSha256
                )
                    throw new GitHubPublicationConflict(
                        "The original file fingerprint changed."
                    );
                if (file.content === original)
                    throw new GitHubPublicationConflict(
                        "The selected file has no content change."
                    );
            }
            if (file.content === null) {
                changes.push({ path: file.path, mode, type: "blob", sha: null });
                expected.delete(file.path);
            } else {
                changes.push({
                    path: file.path,
                    mode,
                    type: "blob",
                    content: file.content,
                });
                expected.set(file.path, {
                    path: file.path,
                    mode,
                    type: "blob",
                    sha: githubBlobHash(Buffer.from(file.content)),
                    size: Buffer.byteLength(file.content),
                });
            }
        }
        return { baseTree: commit.tree.sha, changes, expected };
    }
    protected ownedPull(pull: GitHubPullRequest, branch: string): GitHubPullRequest {
        if (
            pull.user.login !== githubTarget.login ||
            pull.user.id !== githubTarget.accountId ||
            pull.head.repo.id !== githubTarget.repositoryId ||
            pull.head.repo.full_name !== githubTarget.repository ||
            pull.base.repo.id !== githubTarget.repositoryId ||
            pull.base.repo.full_name !== githubTarget.repository ||
            pull.head.ref !== branch ||
            pull.base.ref !== githubTarget.branch ||
            pull.html_url !==
                `https://github.com/${githubTarget.repository}/pull/${pull.number}`
        )
            throw new Error("GitHub returned a different publication identity.");
        return pull;
    }
    /**
     * Inspect one attempt's existing branch and PR without replaying writes or changing its state.
     * @param id - Durable publication UUID; only its fixed branch can be queried.
     * @param signal - Cancellation and caller's reconciliation deadline.
     * @returns Independent branch and PR observations; absence is not permission to replay an uncertain write.
     */
    async inspectPublication(id: string, signal: AbortSignal) {
        const branch = githubPublicationBranch(id);
        await this.verifyBinding(signal);
        const sha = await this.reference(branch, signal, true);
        const rows = v.parse(
            v.pipe(v.array(pullSchema), v.maxLength(2)),
            await this.json(
                "GET",
                `${githubRepositoryPath}/pulls?state=all&head=${encodeURIComponent(`rajohan:${branch}`)}&base=main&per_page=2`,
                signal
            )
        );
        if (rows.length > 1)
            throw new Error(
                "Publication has ambiguous pull requests; operator review is required."
            );
        const pull = rows[0] ? this.ownedPull(rows[0], branch) : null;
        return {
            branch,
            branchSha: sha,
            pullRequest: pull
                ? {
                      number: pull.number,
                      url: pull.html_url,
                      state: pull.state,
                      draft: pull.draft,
                      commit: pull.head.sha,
                      base: pull.base.sha,
                  }
                : null,
        };
    }
}
