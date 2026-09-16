import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as v from "valibot";

const spanSchema = v.object({ line: v.number() });
const reportSchema = v.object({
    diagnostics: v.array(
        v.object({
            code: v.string(),
            labels: v.array(v.object({ span: spanSchema })),
        })
    ),
});

test("documentation lint requires public contracts without requiring private helpers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "homelab-jsdoc-"));
    const fixturePath = path.join(directory, "fixture.ts");
    const source = [
        "// Ordinary comments do not document an exported API.",
        "export function undocumented() {}",
        "const indirect = () => {};",
        "export { indirect };",
        "export const expression = function () {};",
        "function internal() {}",
        "export class Service {",
        "    run() {}",
        "    private hidden() {}",
        "    protected inherited() {}",
        "    #secret() {}",
        "    get value() { return 1; }",
        "    set value(value: number) {}",
        "    task = () => {};",
        "}",
        "export interface Contract { execute(): void; }",
        "/** Describe the operation. */",
        "export function documented() {}",
        "class InternalService {",
        "    /** Describe the public method. */",
        "    run() {}",
        "    private hidden() {}",
        "}",
        "/** @returns The result. */",
        "export function descriptionMissing() { return 1; }",
        "/** Describe the operation. */",
        "export function parameterMissing(value: string) {}",
        "/** */",
        "export function emptyComment() {}",
    ].join("\n");
    try {
        await Bun.write(fixturePath, source);
        const child = Bun.spawn(
            [
                process.execPath,
                "scripts/lint.ts",
                "--config",
                "oxlint.config.ts",
                "--format",
                "json",
                fixturePath,
            ],
            { stdout: "pipe", stderr: "pipe" }
        );
        const [output, errors, result] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(errors).toBe("");
        expect(result).toBe(1);
        const report = v.parse(reportSchema, JSON.parse(output));
        const lines = (code: string) =>
            report.diagnostics
                .filter((diagnostic) => diagnostic.code === code)
                .flatMap((diagnostic) =>
                    diagnostic.labels.map((label) => label.span.line)
                )
                .toSorted((left, right) => left - right);
        expect(lines("documentation(exported)")).toEqual([2, 3, 5]);
        expect(lines("documentation(methods)")).toEqual([8, 12, 13, 14, 16]);
        expect(lines("documentation(description)")).toContain(24);
        expect(lines("jsdoc(require-param)")).toContain(27);
        expect(lines("jsdoc(no-blank-blocks)")).toContain(28);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 15_000);
