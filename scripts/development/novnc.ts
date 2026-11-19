import type { BunPlugin } from "bun";

// Bun's HMR loader initializes noVNC's browser bindings out of order. Keep the
// unchanged dependency in one browser module; application HMR stays enabled.
const novnc: BunPlugin = {
    name: "novnc-bun-hmr",
    target: "browser",
    /** Bundle the installed noVNC entrypoint without HMR wrappers.
     * @param build - Development module loading hooks.
     */
    setup(build) {
        build.onLoad(
            { filter: /[/\\]@novnc[/\\]novnc[/\\]core[/\\]rfb\.js$/u },
            async ({ path }) => {
                const result = await Bun.build({
                    entrypoints: [path],
                    target: "browser",
                    format: "esm",
                    env: "disable",
                    plugins: [],
                });
                if (!result.success || result.outputs.length !== 1)
                    throw new Error("noVNC development bundle failed.");
                return { contents: await result.outputs[0]!.text(), loader: "js" };
            }
        );
    },
};
export default novnc;
