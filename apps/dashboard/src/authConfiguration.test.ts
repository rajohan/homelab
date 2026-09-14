import { describe, expect, test } from "bun:test";

import { parseDashboardAuthConfiguration } from "./authConfiguration";
const valid = {
    NODE_ENV: "production",
    HOMELAB_DASHBOARD_AUTH_ISSUER: "https://auth.example.test",
    HOMELAB_DASHBOARD_ORIGIN: "https://dashboard.example.test",
    HOMELAB_DASHBOARD_OIDC_CLIENT_ID: "dashboard",
    HOMELAB_DASHBOARD_OIDC_CLIENT_SECRET: "isolated-client-secret-not-production",
    HOMELAB_DASHBOARD_SESSION_KEY: Buffer.alloc(32, 8).toString("base64"),
};
describe("dashboard identity configuration", () => {
    test("requires independent production configuration and a 32-byte session key", () => {
        expect(parseDashboardAuthConfiguration(valid)?.development).toBe(false);
        expect(() =>
            parseDashboardAuthConfiguration({ NODE_ENV: "production" })
        ).toThrow();
        expect(() =>
            parseDashboardAuthConfiguration({
                ...valid,
                HOMELAB_DASHBOARD_SESSION_KEY: "short",
            })
        ).toThrow();
    });
    test("rejects insecure, credential-bearing and non-origin endpoints", () => {
        for (const issuer of [
            "http://localhost:3101",
            "https://user:secret@example.test",
            "https://auth.example.test/path",
        ]) {
            expect(() =>
                parseDashboardAuthConfiguration({
                    ...valid,
                    HOMELAB_DASHBOARD_AUTH_ISSUER: issuer,
                })
            ).toThrow();
        }
    });
    test("allows loopback relaxation only in explicit development", () => {
        expect(
            parseDashboardAuthConfiguration({
                ...valid,
                NODE_ENV: "development",
                HOMELAB_DASHBOARD_AUTH_DEVELOPMENT: "true",
                HOMELAB_DASHBOARD_AUTH_ISSUER: "http://localhost:3101",
                HOMELAB_DASHBOARD_ORIGIN: "http://localhost:3100",
            })?.development
        ).toBe(true);
        expect(
            parseDashboardAuthConfiguration({ NODE_ENV: "development" })
        ).toBeUndefined();
    });
});
