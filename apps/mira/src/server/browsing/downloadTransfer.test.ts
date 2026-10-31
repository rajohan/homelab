import { expect, test } from "bun:test";

import {
    BrowserDownloadReceiver,
    BrowserDownloadTransfer,
    browserDownloadLimit,
} from "./downloadTransfer";

const file = (length = 100_003) => {
    const bytes = new Uint8Array(length).fill(97);
    return { bytes, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
};
test("private download chunks preserve exact bytes without allowing offset replay or early finish", () => {
    const sender = new BrowserDownloadTransfer(),
        source = file();
    expect(sender.active).toBe(false);
    const header = sender.begin(source),
        receiver = new BrowserDownloadReceiver(header);
    expect(sender.active).toBe(true);
    expect(() => sender.begin(source)).toThrow();
    expect(() => sender.take({ offset: 1 })).toThrow();
    for (let offset = 0; offset < source.bytes.length; offset += 24 * 1024) {
        const part = sender.take({ offset });
        receiver.accept(part);
        expect(() => sender.take({ offset })).toThrow();
    }
    expect(receiver.finish()).toEqual(source);
    expect(() => receiver.finish()).toThrow();
    expect(() =>
        receiver.accept({ offset: source.bytes.length, data: "YQ==" })
    ).toThrow();
    sender.finish();
    expect(sender.active).toBe(false);
    expect(() => sender.finish()).toThrow();
    sender.begin(source);
    expect(() => sender.finish()).toThrow();
    expect(sender.active).toBe(false);
    sender.begin(source);
    sender.clear();
    expect(() => sender.take({ offset: 0 })).toThrow();
});
test("download reception rejects malformed, oversized, corrupt and incomplete artifacts", () => {
    const source = file(2);
    for (const size of [0, -1, 1.5, browserDownloadLimit + 1])
        expect(
            () => new BrowserDownloadReceiver({ size, sha256: source.sha256 })
        ).toThrow();
    expect(() => new BrowserDownloadReceiver({ size: 2, sha256: "bad" })).toThrow();
    expect(() =>
        new BrowserDownloadTransfer().begin({ ...source, sha256: "a".repeat(64) })
    ).toThrow();
    for (const part of [
        { offset: 1, data: "YWE=" },
        { offset: 0, data: "YWFh" },
        { offset: 0, data: "YR==" },
        { offset: 0, data: "YQ" },
        { offset: 0, data: "" },
        { offset: 0, data: "YWE=", path: "/tmp/file" },
    ]) {
        const receiver = new BrowserDownloadReceiver({ size: 2, sha256: source.sha256 });
        expect(() => receiver.accept(part)).toThrow();
    }
    const incomplete = new BrowserDownloadReceiver({ size: 2, sha256: source.sha256 });
    expect(() => incomplete.finish()).toThrow();
    const corrupt = new BrowserDownloadReceiver({ size: 2, sha256: source.sha256 });
    corrupt.accept({ offset: 0, data: "YmI=" });
    expect(() => corrupt.finish()).toThrow();
});
