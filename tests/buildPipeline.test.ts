import { expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deferRouterChunkBinding } from "../scripts/development/routerHmr";

test("defers the installed RouterCore development cycle without changing other code", async () => {
    const router = Bun.resolveSync(
        "@tanstack/react-router",
        new URL("../apps/dashboard", import.meta.url).pathname
    );
    const entry = Bun.resolveSync("@tanstack/router-core", path.dirname(router));
    const source = await Bun.file(new URL("router.js", pathToFileURL(entry))).text();
    const transformed = deferRouterChunkBinding(source);
    expect(transformed).toContain(
        "_replaceRouteChunk = (...args) => replaceRouteChunk(...args)"
    );
    expect(
        transformed.replace(
            "(...args) => replaceRouteChunk(...args)",
            "replaceRouteChunk"
        )
    ).toBe(source);
    expect(() => deferRouterChunkBinding("upstream changed")).toThrow(
        "Review the TanStack"
    );
});

test("the native React Compiler emits memoization for browser components", async () => {
    const source =
        "export function Example({ title }: { title: string }) { return <h1>{title}</h1>; }";
    const result = await Bun.build({
        entrypoints: ["/homelab-compiler-check.tsx"],
        files: { "/homelab-compiler-check.tsx": source },
        target: "browser",
        packages: "external",
        reactCompiler: true,
        reactCompilerOutputMode: "client",
    });
    expect(result.success).toBe(true);
    const output = await result.outputs[0]?.text();
    expect(output).toContain("react/compiler-runtime");
    expect(output).toContain("_c(2)");
});
