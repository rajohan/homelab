import { expect, test } from "bun:test";

import { BrowserUploadTransfer, browserUploadParts } from "./uploadTransfer";

function file(size = 100_003) {
    const bytes = new Uint8Array(size).fill(97);
    return {
        name: "fixture.txt",
        size,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        bytes,
    };
}
function header(selected = file()) {
    return {
        input: { observationId: crypto.randomUUID(), ref: "p1:1" },
        file: { name: selected.name, size: selected.size, sha256: selected.sha256 },
    };
}

test("private upload chunks preserve exact bytes, size, digest and observation", () => {
    const selected = file(),
        input = header(selected),
        transfer = new BrowserUploadTransfer();
    expect(transfer.active).toBe(false);
    transfer.begin(input);
    expect(transfer.active).toBe(true);
    for (const part of browserUploadParts(selected)) {
        expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(64 * 1024);
        transfer.accept(part);
    }
    expect(transfer.finish()).toEqual({ input: input.input, file: selected });
    expect(transfer.active).toBe(false);
    expect(() => transfer.finish()).toThrow();
});

test("private upload chunks refuse gaps, duplicates, overflow, invalid encoding and incomplete files", () => {
    const selected = file(1);
    for (const part of [
        { offset: 1, data: "YQ==" },
        { offset: 0, data: "YWI=" },
        { offset: 0, data: "" },
        { offset: 0, data: "YR==" },
        { offset: 0, data: "YQ" },
        { offset: 0, data: "YQ==", path: "/secret" },
    ]) {
        const transfer = new BrowserUploadTransfer();
        transfer.begin(header(selected));
        expect(() => transfer.accept(part)).toThrow();
    }
    const transfer = new BrowserUploadTransfer();
    expect(() => transfer.accept({ offset: 0, data: "YQ==" })).toThrow();
    transfer.begin(header(selected));
    expect(() => transfer.begin(header(selected))).toThrow();
    expect(() => transfer.finish()).toThrow();
    transfer.begin(header(selected));
    transfer.accept({ offset: 0, data: "YQ==" });
    expect(() => transfer.accept({ offset: 0, data: "YQ==" })).toThrow();
    transfer.clear();
    expect(transfer.active).toBe(false);
    expect(() => transfer.finish()).toThrow();
});

test("upload lifetime quotas cannot be reclaimed by cancellation and changed bytes fail digest checks", () => {
    const selected = file(1),
        transfer = new BrowserUploadTransfer();
    transfer.begin(header(selected));
    transfer.accept({ offset: 0, data: "Yg==" });
    expect(() => transfer.finish()).toThrow();
    for (let i = 1; i < 16; i++) {
        transfer.begin(header(selected));
        transfer.clear();
    }
    expect(() => transfer.begin(header(selected))).toThrow();
    const total = new BrowserUploadTransfer();
    total.begin({
        ...header(selected),
        file: { ...header(selected).file, size: 25 * 1024 * 1024 },
    });
    total.clear();
    expect(() => total.begin(header(selected))).toThrow();
});
