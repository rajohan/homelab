import { expect, test } from "bun:test";

import { describeFile } from "./files";

test.each([
    ["report.MD", "markdown", "markdown"],
    ["result.json", "json", "json"],
    ["src/example.tsx", "code", "typescript"],
    ["Dockerfile.browser", "code", "dockerfile"],
    [".env.example", "code", "ini"],
    ["change.patch", "code", "diff"],
    ["settings.toml", "code", "ini"],
    ["report.csv", "table", "text"],
    ["unfamiliar.bin", "text", "text"],
] as const)("classifies %s consistently across file surfaces", (name, kind, language) => {
    expect(describeFile({ name })).toMatchObject({ kind, language });
});

test("verified image and PDF metadata wins over a misleading filename", () => {
    expect(describeFile({ name: "report.txt", mediaType: "application/pdf" }).kind).toBe(
        "pdf"
    );
    expect(describeFile({ name: "report.json", mediaType: "image/png" }).kind).toBe(
        "image"
    );
    expect(
        describeFile({ name: "diagram.svg", mediaType: "image/svg+xml" })
    ).toMatchObject({ kind: "code", language: "xml" });
});
