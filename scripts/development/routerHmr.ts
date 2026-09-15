import type { BunPlugin } from "bun";

const eagerAssignment = "RouterCore.prototype._replaceRouteChunk = replaceRouteChunk;";
const deferredAssignment =
    "RouterCore.prototype._replaceRouteChunk = (...args) => replaceRouteChunk(...args);";

// Bun's development module loader evaluates the RouterCore/load-client cycle eagerly.
// Defer this one binding; do not modify installed dependencies or production output.
/**
 * Apply the guarded TanStack Router workaround for Bun's development chunk initialization.
 * @param source - The exact dependency module contents.
 * @returns The module with its eager binding deferred.
 * @throws {Error} The expected dependency shape changed and the workaround needs review.
 */
export function deferRouterChunkBinding(source: string): string {
    if (source.split(eagerAssignment).length !== 2)
        throw new Error(
            "Review the TanStack Router HMR workaround after this dependency update."
        );
    return source.replace(eagerAssignment, deferredAssignment);
}

const routerHmr: BunPlugin = {
    name: "tanstack-router-bun-hmr",
    target: "browser",
    setup(build) {
        build.onLoad(
            {
                filter: /[/\\]@tanstack[/\\]router-core[/\\]dist[/\\]esm[/\\]router\.js$/u,
                namespace: "file",
            },
            async ({ path }) => ({
                contents: deferRouterChunkBinding(await Bun.file(path).text()),
                loader: "js",
            })
        );
    },
};

export default routerHmr;
