import { expect, test } from "bun:test";

import { describeFile, formatJsonPreview } from "./files";

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

test.each([
    ["notes.md", "application/json", "json", "json"],
    ["notes.md", "application/problem+json", "json", "json"],
    ["data.json", "text/markdown", "markdown", "markdown"],
    ["notes.md", "image/svg+xml", "code", "xml"],
    ["notes.md", "text/html", "code", "html"],
] as const)(
    "explicit %s media %s wins over the original filename",
    (name, mediaType, kind, language) => {
        expect(describeFile({ name, mediaType })).toMatchObject({ kind, language });
    }
);

test("formatted JSON preserves original numeric and escaped-string lexemes", () => {
    const source = String.raw`{"id":9007199254740993,"negative":-0,"huge":1e400,"precise":1.234567890123456789,"escaped":"\u0061\"\\","empty":[]}`;
    const preview = formatJsonPreview(source);
    expect(preview).toStartWith('{\n  "id": 9007199254740993,');
    expect(preview).toContain('"negative": -0');
    expect(preview).toContain('"huge": 1e400');
    expect(preview).toContain('"precise": 1.234567890123456789');
    expect(preview).toContain(String.raw`"escaped": "\u0061\"\\"`);
    expect(JSON.parse(preview)).toEqual(JSON.parse(source));
    expect(preview).toContain('"empty": []');
    expect(() => formatJsonPreview('{"unfinished":')).toThrow();
});

test("deep JSON has bounded formatting and large previews retain a truncation sentinel", () => {
    const deep = "[".repeat(10_000) + "0" + "]".repeat(10_000);
    expect(formatJsonPreview(deep).length).toBe(64_001);
    expect(formatJsonPreview(JSON.stringify({ text: "a".repeat(100_000) })).length).toBe(
        64_001
    );
});
