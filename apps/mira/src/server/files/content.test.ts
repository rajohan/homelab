import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { miraFileType } from "../data/files";
import { syntheticPdf } from "../testing/document";
import { readMiraPdf } from "./content";

test("uploaded document types are identified by bytes and binary content is rejected", () => {
    expect(miraFileType(new TextEncoder().encode("name,value\nsynthetic,1"))).toBe(
        "text/plain; charset=utf-8"
    );
    expect(miraFileType(syntheticPdf())).toBe("application/pdf");
    expect(miraFileType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
        "image/png"
    );
    expect(() => miraFileType(new Uint8Array([0, 1, 2, 3]))).toThrow(/UTF-8/);
});

test("PDF parsing returns text in a separate bounded process", async () => {
    const result = await readMiraPdf(syntheticPdf(), AbortSignal.timeout(10_000));
    expect(result.text).toContain("Synthetic Mira document");
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
    await rejects(
        readMiraPdf(
            new TextEncoder().encode("%PDF-invalid"),
            AbortSignal.timeout(10_000)
        ),
        /could not be read/
    );
    await rejects(readMiraPdf(syntheticPdf(), AbortSignal.abort()));
});
