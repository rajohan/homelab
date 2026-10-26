import * as v from "valibot";

import { sandboxPathSchema } from "../../sandbox/edits";
import { githubTarget } from "./configuration";
import { gitShaSchema, sourceCommitSchema } from "./protocol";
import { GitHubClient, githubRepositoryPath } from "./repository";

const text = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const integer = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(Number.MAX_SAFE_INTEGER)
);
const repo = v.object({ id: integer, full_name: text(256) });
const branch = v.object({ ref: text(240), sha: gitShaSchema, repo: v.nullable(repo) });
const pull = v.object({
    number: integer,
    html_url: text(1024),
    title: text(256),
    body: v.nullable(text(65_536)),
    state: v.picklist(["open", "closed"]),
    draft: v.boolean(),
    user: v.nullable(v.object({ id: integer, login: text(100) })),
    head: branch,
    base: branch,
    updated_at: v.pipe(v.string(), v.isoTimestamp()),
});
const detail = v.object({
    ...pull.entries,
    changed_files: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export const githubWorkSchema = v.strictObject({
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(40)), 1),
});
export const githubPullReadSchema = v.strictObject({
    number: integer,
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)), 1),
});
export const githubSourceTreeSchema = v.strictObject({
    commit: gitShaSchema,
    prefix: v.optional(sandboxPathSchema),
    after: v.optional(text(4096)),
});
export const githubSourceFileSchema = v.strictObject({
    commit: gitShaSchema,
    path: sandboxPathSchema,
});

function summary(raw: v.InferOutput<typeof pull>) {
    if (
        raw.base.repo?.id !== githubTarget.repositoryId ||
        raw.base.repo.full_name !== githubTarget.repository ||
        raw.html_url !==
            `https://github.com/${githubTarget.repository}/pull/${raw.number}`
    )
        throw new Error("GitHub returned a different repository or PR URL.");
    return {
        number: raw.number,
        url: raw.html_url,
        title: raw.title,
        state: raw.state,
        draft: raw.draft,
        author: raw.user?.login ?? null,
        head: {
            commit: raw.head.sha,
            branch: raw.head.ref,
            repository: raw.head.repo?.full_name ?? null,
        },
        base: { commit: raw.base.sha, branch: raw.base.ref },
        updatedAt: raw.updated_at,
    };
}
/** Fixed-repository passive context for planning; no write method or merge/CI authority is exposed. */
export class GitHubReader extends GitHubClient {
    /**
     * Read one bounded page of all open repository PRs and current main.
     * @param input - Validated page number, never a repository or account selector.
     * @param signal - Operation deadline and cancellation.
     * @returns Public metadata with explicit pagination; concurrent PR changes can affect later pages.
     */
    async work(input: v.InferInput<typeof githubWorkSchema>, signal: AbortSignal) {
        const { page } = v.parse(githubWorkSchema, input);
        await this.verifyBinding(signal);
        const commit = await this.reference(githubTarget.branch, signal);
        const rows = v.parse(
            v.pipe(v.array(pull), v.maxLength(25)),
            await this.json(
                "GET",
                `${githubRepositoryPath}/pulls?state=open&sort=created&direction=desc&per_page=25&page=${page}`,
                signal
            )
        );
        if (
            rows.some((row) => row.state !== "open") ||
            new Set(rows.map((row) => row.number)).size !== rows.length
        )
            throw new Error("GitHub returned an inconsistent open PR page.");
        await this.requireBase(commit!, signal);
        return {
            repository: githubTarget.repository,
            commit,
            page,
            rows: rows.map((row) => summary(row)),
            nextPage: rows.length === 25 && page < 40 ? page + 1 : null,
            truncated: rows.length === 25 && page === 40,
            complete: page === 1 && rows.length < 25,
            consistency: "best_effort" as const,
        };
    }
    /**
     * Read one PR's description and a bounded page of changed paths, without fetching its fork or running code.
     * @param input - Repository-local PR number and file page.
     * @param signal - Deadline and cancellation.
     * @returns Head-bound passive context; no check, approval, mergeability or publication claim.
     */
    async pullRequest(
        input: v.InferInput<typeof githubPullReadSchema>,
        signal: AbortSignal
    ) {
        const { number, page } = v.parse(githubPullReadSchema, input);
        await this.verifyBinding(signal);
        const route = `${githubRepositoryPath}/pulls/${number}`;
        const before = v.parse(detail, await this.json("GET", route, signal));
        if (before.number !== number) throw new Error("GitHub returned a different PR.");
        const metadata = summary(before);
        const files = v.parse(
            v.pipe(
                v.array(
                    v.object({
                        filename: text(4096),
                        previous_filename: v.optional(text(4096)),
                        status: v.picklist([
                            "added",
                            "removed",
                            "modified",
                            "renamed",
                            "copied",
                            "changed",
                            "unchanged",
                        ]),
                    })
                ),
                v.maxLength(30)
            ),
            await this.json("GET", `${route}/files?per_page=30&page=${page}`, signal)
        );
        if (
            new Set(files.map((file) => file.filename)).size !== files.length ||
            files.length >
                Math.max(0, Math.min(30, before.changed_files - (page - 1) * 30))
        )
            throw new Error("GitHub returned an inconsistent file page.");
        const after = v.parse(detail, await this.json("GET", route, signal));
        if (JSON.stringify(before) !== JSON.stringify(after))
            throw new Error(
                "The pull request changed while it was being inspected. Read it again."
            );
        const body = before.body ?? "";
        return {
            ...metadata,
            body: body.slice(0, 8000),
            bodyTruncated: body.length > 8000,
            files: files.map((file) => ({
                path: file.filename,
                previousPath: file.previous_filename ?? null,
                status: file.status,
            })),
            totalFiles: before.changed_files,
            page,
            nextPage:
                page * 30 < before.changed_files && files.length === 30 && page < 10
                    ? page + 1
                    : null,
            truncated:
                before.changed_files > 300 ||
                files.length <
                    Math.min(30, Math.max(0, before.changed_files - (page - 1) * 30)),
        };
    }
    private async source(commit: string, signal: AbortSignal) {
        await this.verifyBinding(signal);
        await this.requireBase(commit, signal);
        const raw = v.parse(
            sourceCommitSchema,
            await this.json(
                "GET",
                `${githubRepositoryPath}/git/commits/${commit}`,
                signal
            )
        );
        if (raw.sha !== commit)
            throw new Error("GitHub returned a different source commit.");
        return this.tree(raw.tree.sha, signal);
    }
    /**
     * Inspect a page of the exact current main tree without a checkout or code execution.
     * @param input - Exact commit, optional directory prefix and lexical continuation.
     * @param signal - Deadline and cancellation.
     * @returns At most 100 entries and a cursor; truncated provider trees fail rather than masquerading as absent files.
     */
    async sourceTree(
        input: v.InferInput<typeof githubSourceTreeSchema>,
        signal: AbortSignal
    ) {
        const { commit, prefix, after } = v.parse(githubSourceTreeSchema, input);
        const tree = await this.source(commit, signal);
        const selected = tree
            .filter(
                (entry) =>
                    (!prefix ||
                        entry.path === prefix ||
                        entry.path.startsWith(`${prefix}/`)) &&
                    (!after || entry.path > after)
            )
            .toSorted((a, b) => {
                if (a.path === b.path) return 0;
                return a.path < b.path ? -1 : 1;
            });
        const rows = selected.slice(0, 100);
        await this.requireBase(commit, signal);
        return {
            commit,
            rows,
            nextAfter: selected.length > 100 ? rows.at(-1)!.path : null,
        };
    }
    /**
     * Read a complete verified regular UTF-8 source file up to 64 KiB from current main.
     * @param input - Exact main commit and validated repository-relative path.
     * @param signal - Deadline and cancellation.
     * @returns Exact text, mode and fingerprints, or an explicit missing/unsupported/too-large result.
     */
    async sourceFile(
        input: v.InferInput<typeof githubSourceFileSchema>,
        signal: AbortSignal
    ) {
        const { commit, path } = v.parse(githubSourceFileSchema, input);
        const tree = await this.source(commit, signal),
            entry = tree.find((item) => item.path === path);
        const parents = path.split("/").slice(0, -1);
        const guidance = [
            "AGENTS.md",
            ...parents.map(
                (_, index) => `${parents.slice(0, index + 1).join("/")}/AGENTS.md`
            ),
        ].filter((name) => tree.some((item) => item.path === name));
        const common = { commit, path, guidance };
        let result;
        if (!entry) result = { ...common, status: "missing" as const };
        else if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
            result = { ...common, status: "unsupported" as const };
        else if (entry.size === undefined || entry.size > 65_536)
            result = { ...common, status: "too_large" as const };
        else {
            const { bytes, text: content } = await this.blob(entry, signal, 65_536);
            result = {
                ...common,
                status: "ready" as const,
                content,
                mode: entry.mode,
                bytes: bytes.length,
                gitSha: entry.sha,
                sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
            };
        }
        await this.requireBase(commit, signal);
        return result;
    }
}
