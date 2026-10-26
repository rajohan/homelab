import { githubTarget } from "../integrations/github/configuration";
import { GitHubReader } from "../integrations/github/reader";
import { base, configuration, githubProvider, type Intercept } from "./github";

/**
 * Build passive GitHub fixtures without credentials or network access.
 * @param intercept - Optional response mutation or concurrency injection.
 * @returns Reader, recorded requests and mutable synthetic PR/file/source fixtures.
 */
export function githubReadProvider(intercept?: Intercept) {
    const repo = { id: githubTarget.repositoryId, full_name: githubTarget.repository };
    const pulls = [
        {
            number: 123,
            html_url: "https://github.com/rajohan/homelab/pull/123",
            title: "fix: existing improvement",
            body: "An existing proposal.",
            state: "open",
            draft: true,
            user: { id: githubTarget.accountId, login: githubTarget.login },
            head: { ref: "feat/existing", sha: "c".repeat(40), repo },
            base: { ref: "main", sha: base, repo },
            updated_at: "2026-10-26T05:00:00Z",
            changed_files: 2,
        },
    ];
    const files = [
        { filename: "src/app.ts", status: "modified" },
        { filename: "old.txt", previous_filename: "older.txt", status: "renamed" },
    ];
    const provider = githubProvider(
        "11111111-1111-4111-8111-111111111111",
        (url, init, fallback) => {
            const reply = () => {
                if (url.pathname === "/repos/rajohan/homelab/pulls") {
                    const page = Number(url.searchParams.get("page"));
                    return Response.json(pulls.slice((page - 1) * 25, page * 25));
                }
                if (url.pathname === "/repos/rajohan/homelab/pulls/123")
                    return Response.json(pulls[0]);
                if (url.pathname === "/repos/rajohan/homelab/pulls/123/files") {
                    const page = Number(url.searchParams.get("page"));
                    return Response.json(files.slice((page - 1) * 30, page * 30));
                }
                return fallback();
            };
            return intercept ? intercept(url, init, reply) : reply();
        }
    );
    return {
        ...provider,
        reader: new GitHubReader(configuration, provider.request),
        pulls,
        files,
    };
}
