import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";
import { imageVersionTag } from "./imageReference";

const tagSchema = v.object({ name: v.pipe(v.string(), v.maxLength(128)) });
const pageSchema = v.object({
    next: v.nullable(v.string()),
    results: v.pipe(v.array(tagSchema), v.maxLength(100)),
});

/**
 * Find a verified newer stable tag without scanning an unbounded Hub catalog.
 * @param repository - Validated public namespace/repository, never a URL.
 * @param installed - Installed stable tag with an optional distribution flavor.
 * @param signal - Shared lookup deadline.
 * @param request - HTTP boundary replaceable by fixtures.
 * @returns A newer candidate, or the installed tag only after a complete catalog.
 * @throws {Error} When a partial catalog cannot establish whether an update exists.
 */
export async function dockerHubVersionTag(
    repository: string,
    installed: string,
    signal: AbortSignal,
    request: typeof fetch
): Promise<string> {
    const current = imageVersionTag(installed);
    const parts = repository.split("/");
    if (
        !current ||
        parts.length !== 2 ||
        parts.some((part) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part))
    )
        throw new Error("Unsupported Docker Hub version catalog");
    let selectedTag = installed;
    let selected = current;
    for (let page = 1; page <= 5; page += 1) {
        signal.throwIfAborted();
        const url = new URL(
            `https://hub.docker.com/v2/namespaces/${parts[0]}/repositories/${parts[1]}/tags`
        );
        url.search = new URLSearchParams({
            page: String(page),
            page_size: "100",
            ordering: "last_updated",
        }).toString();
        const response = await request(url, { signal, redirect: "error" });
        const result = v.parse(pageSchema, await readBoundedJson(response));
        for (const { name } of result.results) {
            const candidate = imageVersionTag(name);
            if (
                candidate &&
                candidate.flavor === current.flavor &&
                candidate.prefix === current.prefix &&
                Bun.semver.order(candidate.version, selected.version) > 0
            ) {
                selected = candidate;
                selectedTag = name;
            }
        }
        // A positive observation does not require proving the globally newest tag.
        // The manifest resolver verifies the candidate's actual target platform.
        if (selectedTag !== installed || result.next === null) return selectedTag;
        if (result.results.length === 0)
            throw new Error("Docker Hub tag catalog did not advance");
    }
    throw new Error("Docker Hub tag catalog exceeds the lookup budget");
}
