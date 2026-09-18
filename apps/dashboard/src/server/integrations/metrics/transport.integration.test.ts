import { expect, test } from "bun:test";

import { collectHistory } from "./history";
import { buildHosts } from "./hosts";
import { collectInventory } from "./inventory";
import { queryMetrics } from "./transport";

test("rejects oversized responses and invalid monitoring types without forwarding bodies", async () => {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const expression = new URL(request.url).searchParams.get("query");
            if (expression === "large") return new Response("x".repeat(2_000_001));
            if (expression === "redirect")
                return Response.redirect("https://untrusted.example", 302);
            if (expression === "failure")
                return new Response("private monitoring error", { status: 500 });
            return Response.json({
                status: "success",
                data: { resultType: "scalar", result: [1, "4"] },
            });
        },
    });
    const configuration = { url: `http://127.0.0.1:${server.port}`, token: undefined };
    try {
        for (const expression of ["large", "redirect", "failure", "invalid"]) {
            const result = await queryMetrics(
                configuration,
                expression,
                AbortSignal.timeout(1000)
            ).catch((error: unknown) => error);
            expect(result).toBeInstanceOf(Error);
            expect(String(result)).not.toContain("private monitoring error");
        }
    } finally {
        await server.stop(true);
    }
});

test("collects finite derived rates even when a compatible backend preserves metric names", async () => {
    const offsets: (string | null)[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const query = new URL(request.url).searchParams.get("query") ?? "";
            offsets.push(new URL(request.url).searchParams.get("latency_offset"));
            const result =
                query === "irate(node_network_receive_bytes_total[1m])"
                    ? [
                          {
                              metric: {
                                  __name__: "node_network_receive_bytes_total",
                                  host: "test",
                                  device: "eth0",
                              },
                              value: [1, "0"],
                          },
                      ]
                    : [];
            return Response.json({
                status: "success",
                data: { resultType: "vector", result },
            });
        },
    });
    try {
        const result = await collectInventory(
            { url: `http://127.0.0.1:${server.port}`, token: undefined },
            AbortSignal.timeout(2000)
        );
        expect(result.networks[0]).toMatchObject({
            host: "test",
            device: "eth0",
            receive: null,
        });
        expect(result.hosts).toEqual([]);
        expect(offsets.length).toBeGreaterThan(0);
        expect(offsets.every((offset) => offset === "1s")).toBe(true);
    } finally {
        await server.stop(true);
    }
});

test.each([1, 0])(
    "historical queries retain device sources, gaps and ambiguity checks (exporter up: %s)",
    async (available) => {
        const host = buildHosts({
            up: [
                { labels: { host: "test", job: "node" }, value: available },
                { labels: { host: "cluster", job: "pve" }, value: 1 },
            ],
            pve_guest_info: [
                {
                    labels: {
                        host: "cluster",
                        instance: "cluster-a",
                        id: "qemu/100",
                        name: "test",
                    },
                    value: 1,
                },
            ],
            pve_up: [{ labels: { instance: "cluster-a", id: "qemu/100" }, value: 1 }],
            pve_memory_usage_bytes: [
                { labels: { instance: "cluster-a", id: "qemu/100" }, value: 42 },
            ],
        })[0];
        if (!host) throw new Error("Missing host fixture");
        let duplicate = false;
        const queries: string[] = [];
        const offsets: (string | null)[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                queries.push(new URL(request.url).searchParams.get("query") ?? "");
                offsets.push(new URL(request.url).searchParams.get("latency_offset"));
                const row = {
                    metric: {},
                    values: [
                        [100, "0"],
                        [130, "NaN"],
                        [145, "3"],
                    ],
                };
                return Response.json({
                    status: "success",
                    data: {
                        resultType: "matrix",
                        result: duplicate ? [row, row] : [row],
                    },
                });
            },
        });
        try {
            const configuration = {
                url: `http://127.0.0.1:${server.port}`,
                token: "synthetic-read-token",
            };
            const selection = { host, network: "eth0", disk: "sda" };
            const result = await collectHistory(
                configuration,
                selection,
                "1h",
                AbortSignal.timeout(2000)
            );
            expect(result.cpu[0]?.points).toEqual([
                { time: 100_000, value: 0 },
                { time: 115_000, value: null },
                { time: 130_000, value: null },
                { time: 145_000, value: 3 },
            ]);
            expect(queries).toHaveLength(7);
            expect(queries.every((query) => !query.includes("pve_"))).toBe(true);
            expect(queries.some((query) => query.includes('device="eth0"'))).toBe(true);
            expect(queries.some((query) => query.includes('device="sda"'))).toBe(true);
            expect(result.memory[0]?.label).toBe("Used memory");
            expect(result.memory.map((series) => series.key)).toEqual([
                "memory",
                "memoryCapacity",
            ]);
            expect(queries.every((query) => query.endsWith("[1h:15s]"))).toBe(true);
            expect(offsets.every((offset) => offset === null)).toBe(true);
            duplicate = true;
            const failure = await collectHistory(
                configuration,
                selection,
                "7d",
                AbortSignal.timeout(2000)
            ).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect(failure).toHaveProperty("message", "Historical resource is ambiguous");
        } finally {
            await server.stop(true);
        }
    }
);
