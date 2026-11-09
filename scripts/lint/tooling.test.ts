import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

test("built-in lint retains Tailwind, boundary, accessibility and type-aware diagnostics", async () => {
    const directory = await mkdtemp(
        path.resolve("apps/dashboard/src/browser/bunLintFixture")
    );
    const source = path.join(directory, "Probe.tsx");
    try {
        await writeFile(
            source,
            [
                'import { useMemo } from "react";',
                "/** Show the test image. @returns A test element. */",
                "export function Probe() {",
                'const words = useMemo(() => ["test"], []);',
                'return <img title={words.join("")} src="test" className="p-2 p-2" />;',
                "}",
                "Promise.resolve(1);",
                "const invalid: string = 42;",
                "void invalid;",
            ].join("\n")
        );
        const child = Bun.spawn(
            [
                process.execPath,
                "lint",
                "--no-script",
                "--deny-warnings",
                "--format",
                "json",
                source,
            ],
            {
                stdout: "pipe",
                stderr: "pipe",
                windowsHide: true,
            }
        );
        const [output, errors, result] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(errors).toBe("");
        expect(result).toBe(1);
        const report = v.parse(
            v.object({ diagnostics: v.array(v.object({ code: v.string() })) }),
            JSON.parse(output)
        );
        const codes = report.diagnostics.map((item) => item.code);
        for (const code of [
            "eslint(no-restricted-imports)",
            "jsx-a11y(alt-text)",
            "tailwindcss(no-duplicate-classes)",
            "typescript(no-floating-promises)",
            "typescript(TS2322)",
        ])
            expect(codes).toContain(code);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);
