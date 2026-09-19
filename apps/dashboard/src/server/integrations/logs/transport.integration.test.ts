import { expect, test } from "bun:test";

import { createApplicationFixture } from "../../testing/applications";
import { expectOperationFailure } from "../../testing/operations";
import { readApplicationLogs } from "./transport";

test("Loki history uses escaped exact selectors, exclusive cursors and complete timestamp groups", async () => {
    const fixture = createApplicationFixture();
    try {
        const configuration = { url: fixture.url, token: "synthetic-read-token" };
        const timestamp = String(BigInt(Date.now() - 1000) * 1_000_000n);
        fixture.logs.splice(
            0,
            fixture.logs.length,
            ...Array.from({ length: 250 }, (_, index) => ({
                timestamp,
                message: `<b>Untrusted event ${index}</b> text" |= "injected`,
                level: "info",
            })),
            { timestamp: String(BigInt(timestamp) - 1n), message: "older", level: "info" }
        );
        const first = await readApplicationLogs(
            configuration,
            { host: 'demo"', service: "demo-web" },
            { range: "1h", search: 'text" |= "injected' },
            AbortSignal.timeout(2000)
        );
        expect(first.entries).toHaveLength(250);
        expect(first.nextCursor?.before).toBe(timestamp);
        expect(fixture.queries[0]).toBe(
            '{host="demo\\\"",service="demo-web"} |= "text\\\" |= \\\"injected"'
        );
        const second = await readApplicationLogs(
            configuration,
            { host: "demo" },
            { range: "1h", cursor: first.nextCursor ?? undefined },
            AbortSignal.timeout(2000)
        );
        expect(second.entries.map((entry) => entry.message)).toEqual(["older"]);
        expect(second.nextCursor).toBeNull();
        const filtered = await readApplicationLogs(
            configuration,
            { host: "demo", service: "demo-web" },
            { range: "1h", search: "event 12</b>" },
            AbortSignal.timeout(2000)
        );
        expect(filtered.entries).toHaveLength(1);
        expect(filtered.entries[0]?.message).toContain("event 12</b>");
        const otherService = await readApplicationLogs(
            configuration,
            { host: "demo", service: "demo-database" },
            { range: "1h" },
            AbortSignal.timeout(2000)
        );
        expect(otherService.entries).toHaveLength(0);
        fixture.logs.splice(
            0,
            fixture.logs.length,
            ...Array.from({ length: 220 }, (_, index) => ({
                timestamp: String(BigInt(timestamp) - BigInt(index)),
                message: String(index),
                level: "warning",
            }))
        );
        const page = await readApplicationLogs(
            configuration,
            { host: "demo" },
            { range: "1h" },
            AbortSignal.timeout(2000)
        );
        expect(page.entries).toHaveLength(200);
        const next = await readApplicationLogs(
            configuration,
            { host: "demo" },
            { range: "1h", cursor: page.nextCursor ?? undefined },
            AbortSignal.timeout(2000)
        );
        expect(next.entries).toHaveLength(20);
        expect(
            new Set([...page.entries, ...next.entries].map((entry) => entry.id)).size
        ).toBe(220);
    } finally {
        await fixture.close();
    }
});

test("Loki rejects unbounded colliding groups, invalid cursors, redirects and private error bodies", async () => {
    const fixture = createApplicationFixture();
    const configuration = { url: fixture.url, token: undefined },
        signal = AbortSignal.timeout(3000);
    try {
        const timestamp = String(BigInt(Date.now() - 1000) * 1_000_000n);
        fixture.logs.splice(
            0,
            fixture.logs.length,
            ...Array.from({ length: 1001 }, () => ({
                timestamp,
                message: "same event",
                level: "info",
            }))
        );
        await expectOperationFailure(
            readApplicationLogs(configuration, { host: "demo" }, { range: "1h" }, signal),
            "1,000"
        );
        fixture.logs.splice(
            0,
            fixture.logs.length,
            { timestamp, message: "same", level: "info" },
            { timestamp, message: "same", level: "info" }
        );
        const repeated = await readApplicationLogs(
            configuration,
            { host: "demo" },
            { range: "1h" },
            signal
        );
        expect(new Set(repeated.entries.map((entry) => entry.id)).size).toBe(2);
        await expectOperationFailure(
            readApplicationLogs(
                configuration,
                { host: "demo" },
                {
                    range: "1h",
                    cursor: { since: "1000000000000000000", before: timestamp },
                },
                signal
            ),
            "window"
        );
        await expectOperationFailure(
            readApplicationLogs(
                configuration,
                { "bad-label": "demo" },
                { range: "1h" },
                signal
            ),
            "label"
        );
        await expectOperationFailure(
            readApplicationLogs(configuration, {}, { range: "1h" }, signal),
            "selectors"
        );
        for (const option of ["redirect", "large", "unavailable"] as const) {
            fixture.behavior[option] = true;
            const failure = await readApplicationLogs(
                configuration,
                { host: "demo" },
                { range: "1h" },
                signal
            ).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect(String(failure)).not.toContain("private provider");
            fixture.behavior[option] = false;
        }
    } finally {
        await fixture.close();
    }
});
