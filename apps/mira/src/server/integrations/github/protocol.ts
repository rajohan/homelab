import * as v from "valibot";

export const gitShaSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const text = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const positive = v.pipe(v.number(), v.integer(), v.minValue(1));
export const githubPublicationSchema = v.strictObject({
    id: v.pipe(v.string(), v.uuid()),
    commit: gitShaSchema,
    editsSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    title: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(160),
        v.check((value) => value.isWellFormed() && !value.includes("\0")),
        v.regex(
            /^(feat|fix|perf|refactor|docs|test|build|ci|chore)(\([a-z0-9-]+\))?!?: [^\r\n]+$/
        )
    ),
    body: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(16_000),
        v.check((value) => value.isWellFormed() && !value.includes("\0"))
    ),
    authoredAt: v.pipe(
        v.string(),
        v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/),
        v.check(
            (value) =>
                Number.isFinite(Date.parse(value)) &&
                new Date(value).toISOString() === value
        )
    ),
});
export type GitHubPublication = v.InferOutput<typeof githubPublicationSchema>;
export const treeEntrySchema = v.object({
    path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    mode: v.picklist(["100644", "100755", "040000", "160000", "120000"]),
    type: v.picklist(["blob", "tree", "commit"]),
    sha: gitShaSchema,
    size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
export type GitHubTreeEntry = v.InferOutput<typeof treeEntrySchema>;
export const treeSchema = v.object({
    sha: gitShaSchema,
    truncated: v.literal(false),
    tree: v.pipe(v.array(treeEntrySchema), v.maxLength(10_000)),
});
export const sourceCommitSchema = v.object({
    sha: gitShaSchema,
    tree: v.object({ sha: gitShaSchema }),
});
export const referenceSchema = v.object({
    ref: text(240),
    object: v.object({ type: v.literal("commit"), sha: gitShaSchema }),
});
const actor = v.object({ name: text(256), email: text(320), date: text(100) });
export const createdCommitSchema = v.object({
    ...sourceCommitSchema.entries,
    author: actor,
    committer: actor,
    parents: v.pipe(v.array(v.object({ sha: gitShaSchema })), v.length(1)),
    message: text(20_000),
});
const repo = v.object({ id: positive, full_name: text(256) });
const branch = v.object({ ref: text(240), sha: gitShaSchema, repo });
export const pullSchema = v.object({
    number: positive,
    html_url: text(1024),
    state: v.picklist(["open", "closed"]),
    draft: v.boolean(),
    title: text(256),
    body: v.nullable(text(65_536)),
    user: v.object({ id: positive, login: text(100) }),
    head: branch,
    base: branch,
});
export type GitHubPullRequest = v.InferOutput<typeof pullSchema>;
export type GitHubPublicationPhase = "tree" | "commit" | "branch" | "pull_request";
export interface GitHubPublicationProgress {
    phase: GitHubPublicationPhase;
    state: "sending" | "confirmed";
    branch: string;
    tree?: string;
    commit?: string;
    number?: number;
}
