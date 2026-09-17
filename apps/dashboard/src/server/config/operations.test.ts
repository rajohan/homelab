import { expect, test } from "bun:test";

import { parseOperationsConfiguration } from "./operations";

test("operations are explicit, bounded and independent from identity configuration", () => {
    expect(parseOperationsConfiguration({})).toBeUndefined();
    const input = { HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/dashboard" };
    expect(parseOperationsConfiguration(input)?.concurrency).toBe(3);
    expect(() =>
        parseOperationsConfiguration({
            ...input,
            HOMELAB_DASHBOARD_WORKER_CONCURRENCY: "0",
        })
    ).toThrow();
    expect(() =>
        parseOperationsConfiguration({
            ...input,
            HOMELAB_DASHBOARD_METRICS_URL: "https://user:password@example.test",
        })
    ).toThrow();
    expect(() =>
        parseOperationsConfiguration({
            ...input,
            HOMELAB_DASHBOARD_DATABASE_URL: "sqlite://test",
        })
    ).toThrow();
});
