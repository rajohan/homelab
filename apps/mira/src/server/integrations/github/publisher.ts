import * as v from "valibot";

import { parseSandboxEditPlan } from "../../sandbox/edits";
import { githubPublicationBranch, githubTarget } from "./configuration";
import {
    createdCommitSchema,
    gitShaSchema,
    githubPublicationSchema,
    pullSchema,
    referenceSchema,
    type GitHubPublication,
    type GitHubPublicationPhase,
    type GitHubPublicationProgress,
} from "./protocol";
import {
    GitHubClient,
    GitHubPublicationConflict,
    githubRepositoryPath,
} from "./repository";

/** An attempted external write was not fully confirmed; only read-only reconciliation is safe. */
export class GitHubMutationUncertain extends Error {
    readonly phase: GitHubPublicationPhase;
    /**
     * Record a safe phase label without provider diagnostics, credentials or request content.
     * @param phase - Last attempted external operation; it must never be replayed automatically.
     */
    constructor(phase: GitHubPublicationPhase) {
        super(
            `GitHub ${phase} outcome is uncertain. Inspect this publication before any further action.`
        );
        this.phase = phase;
    }
}
type Guard = () => Promise<void>;
type Progress = (event: GitHubPublicationProgress) => Promise<void>;
type References = Omit<GitHubPublicationProgress, "phase" | "state">;

/** Publish one reviewed change to a fresh branch and draft PR; no ref updates, merges or cleanup deletion. */
export class GitHubPublisher extends GitHubClient {
    private async mutate<T>(
        phase: GitHubPublicationPhase,
        route: string,
        body: unknown,
        references: References,
        signal: AbortSignal,
        guard: Guard,
        progress: Progress,
        validate: (value: unknown) => T | Promise<T>,
        confirmed: (value: T) => Partial<References>
    ): Promise<T> {
        await this.verifyBinding(signal);
        await guard();
        await progress({ ...references, phase, state: "sending" });
        await guard();
        signal.throwIfAborted();
        try {
            const result = await validate(await this.json("POST", route, signal, body));
            await progress({
                ...references,
                ...confirmed(result),
                phase,
                state: "confirmed",
            });
            return result;
        } catch {
            throw new GitHubMutationUncertain(phase);
        }
    }
    /**
     * Publish one immutable, reviewed edit plan through fixed GitHub endpoints.
     * @param request - Service-owned UUID, exact base, edit digest and approved PR/commit metadata.
     * @param bytes - Selected JSON plan; its digest and every original file are rechecked before writing.
     * @param stopping - Cancellation and caller's deadline; this adapter adds a two-minute limit.
     * @param guard - Recheck durable admission, current consent, pause and fenced attempt before each write.
     * @param progress - Persist sending/confirmed phases and known references; failure prevents further writes.
     * @returns Verified draft PR reference. This is not evidence that tests passed or authority to merge/deploy.
     */
    async publish(
        request: GitHubPublication,
        bytes: Uint8Array,
        stopping: AbortSignal,
        guard: Guard,
        progress: Progress
    ) {
        const input = v.parse(githubPublicationSchema, request);
        if (
            new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !==
            input.editsSha256
        )
            throw new GitHubPublicationConflict(
                "The selected edit document no longer matches its approved digest."
            );
        const plan = parseSandboxEditPlan(bytes, input.commit);
        const signal = AbortSignal.any([stopping, AbortSignal.timeout(120_000)]);
        const branch = githubPublicationBranch(input.id);
        const existing = await this.inspectPublication(input.id, signal);
        if (existing.branchSha || existing.pullRequest)
            throw new GitHubPublicationConflict(
                "This publication already has a branch or pull request. Inspect it instead of replaying."
            );
        const prepared = await this.prepare(plan, signal);
        await this.requireBase(input.commit, signal);
        const tree = await this.mutate(
            "tree",
            `${githubRepositoryPath}/git/trees`,
            { base_tree: prepared.baseTree, tree: prepared.changes },
            { branch },
            signal,
            guard,
            progress,
            async (raw) => {
                const { sha } = v.parse(v.object({ sha: gitShaSchema }), raw);
                const observedTree = await this.tree(sha, signal);
                const entries = observedTree.filter((entry) => entry.type !== "tree");
                if (
                    entries.length !== prepared.expected.size ||
                    entries.some((entry) => {
                        const expected = prepared.expected.get(entry.path);
                        return (
                            !expected ||
                            expected.sha !== entry.sha ||
                            expected.mode !== entry.mode ||
                            expected.type !== entry.type
                        );
                    })
                )
                    throw new Error("Created tree differs from the reviewed files.");
                return sha;
            },
            (sha) => ({ tree: sha })
        );
        const actor = {
            name: githubTarget.author,
            email: githubTarget.email,
            date: input.authoredAt,
        };
        const commit = await this.mutate(
            "commit",
            `${githubRepositoryPath}/git/commits`,
            {
                message: input.title,
                tree,
                parents: [input.commit],
                author: actor,
                committer: actor,
            },
            { branch, tree },
            signal,
            guard,
            progress,
            async (raw) => {
                const created = v.parse(createdCommitSchema, raw);
                const verified = v.parse(
                    createdCommitSchema,
                    await this.json(
                        "GET",
                        `${githubRepositoryPath}/git/commits/${created.sha}`,
                        signal
                    )
                );
                for (const value of [created, verified]) {
                    if (
                        value.sha !== created.sha ||
                        value.tree.sha !== tree ||
                        value.parents[0]!.sha !== input.commit ||
                        value.message !== input.title ||
                        [value.author, value.committer].some(
                            (who) =>
                                who.name !== githubTarget.author ||
                                who.email !== githubTarget.email ||
                                Date.parse(who.date) !== Date.parse(input.authoredAt)
                        )
                    )
                        throw new Error(
                            "Commit content or Mira authorship could not be verified."
                        );
                }
                return created.sha;
            },
            (sha) => ({ commit: sha })
        );
        await this.requireBase(input.commit, signal);
        if (await this.reference(branch, signal, true))
            throw new GitHubPublicationConflict(
                "The publication branch appeared during preparation; it was not overwritten."
            );
        await this.mutate(
            "branch",
            `${githubRepositoryPath}/git/refs`,
            { ref: `refs/heads/${branch}`, sha: commit },
            { branch, tree, commit },
            signal,
            guard,
            progress,
            async (raw) => {
                const reference = v.parse(referenceSchema, raw);
                if (
                    reference.ref !== `refs/heads/${branch}` ||
                    reference.object.sha !== commit ||
                    (await this.reference(branch, signal)) !== commit
                )
                    throw new Error("The new branch could not be verified.");
                return commit;
            },
            () => ({})
        );
        await this.requireBase(input.commit, signal);
        if ((await this.reference(branch, signal)) !== commit)
            throw new GitHubPublicationConflict(
                "The publication branch changed; no PR was opened."
            );
        const body = `${input.body}\n\n<!-- homelab:mira:publication:${input.id.toLowerCase()} -->`;
        const pull = await this.mutate(
            "pull_request",
            `${githubRepositoryPath}/pulls`,
            {
                title: input.title,
                body,
                head: branch,
                base: githubTarget.branch,
                draft: true,
                maintainer_can_modify: false,
            },
            { branch, tree, commit },
            signal,
            guard,
            progress,
            (raw) => {
                const created = this.ownedPull(v.parse(pullSchema, raw), branch);
                if (
                    created.head.sha !== commit ||
                    created.base.sha !== input.commit ||
                    created.state !== "open" ||
                    !created.draft ||
                    created.title !== input.title ||
                    created.body !== body
                )
                    throw new Error(
                        "The draft pull request differs from the approved proposal."
                    );
                return created;
            },
            (value) => ({ number: value.number })
        );
        return {
            number: pull.number,
            url: pull.html_url,
            branch,
            commit,
            tree,
            base: input.commit,
            draft: true as const,
        };
    }
}
