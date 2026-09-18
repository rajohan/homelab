import { expect, test } from "bun:test";

import { queryRefresh } from "./queryRefresh";

test("live queries share bounded foreground intervals and refresh on resume", () => {
    for (const [cadence, interval] of [
        ["fast", 5000],
        ["normal", 15_000],
        ["slow", 30_000],
        ["history", 60_000],
    ] as const) {
        expect(queryRefresh(cadence)).toEqual({
            refetchInterval: interval,
            refetchIntervalInBackground: false,
            refetchOnWindowFocus: "always",
            refetchOnReconnect: "always",
        });
    }
});
