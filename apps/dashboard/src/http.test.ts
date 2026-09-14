import { describe, expect, test } from "bun:test";

import { dashboardBindOptions } from "./environment";

describe("dashboard listener configuration", () => {
    test("defaults to loopback", () => {
        expect(dashboardBindOptions({})).toEqual({ hostname: "127.0.0.1", port: 3100 });
    });

    test("allows an explicit container wildcard and IPv6 address", () => {
        expect(dashboardBindOptions({ HOMELAB_DASHBOARD_HOST: "0.0.0.0" }).hostname).toBe(
            "0.0.0.0"
        );
        expect(dashboardBindOptions({ HOMELAB_DASHBOARD_HOST: "::1" }).hostname).toBe(
            "::1"
        );
    });

    test("rejects malformed listener settings", () => {
        for (const port of ["0", "-1", "65536", "3100junk", ""]) {
            expect(() =>
                dashboardBindOptions({ HOMELAB_DASHBOARD_PORT: port })
            ).toThrow();
        }
        expect(() =>
            dashboardBindOptions({ HOMELAB_DASHBOARD_HOST: "example.com" })
        ).toThrow();
    });
});
