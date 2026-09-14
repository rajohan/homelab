import { describe, expect, test } from "bun:test";

import { parseAuthConfiguration } from "./configuration";

function environment(): Record<string, string> {
    return {
        NODE_ENV: "production",
        HOMELAB_AUTH_ISSUER: "https://identity.example.test",
        HOMELAB_AUTH_DASHBOARD_ORIGIN: "https://home.example.test",
        HOMELAB_AUTH_RP_ID: "example.test",
        HOMELAB_AUTH_DATABASE_URL:
            "postgres://test:test@database.example.test/test?sslmode=verify-full",
        HOMELAB_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        HOMELAB_AUTH_COOKIE_KEY: "test-only-cookie-key-of-more-than-43-characters",
        HOMELAB_AUTH_PROXY_KEY: "test-only-proxy-key-of-more-than-43-characters",
        HOMELAB_AUTH_JWKS: JSON.stringify({
            keys: [{ kid: "example", d: "test-only-validation", kty: "RSA" }],
        }),
        HOMELAB_AUTH_CLIENTS: JSON.stringify([
            {
                client_id: "dashboard",
                client_name: "Dashboard",
                client_secret: "test-client-secret-not-production-32",
                redirect_uris: ["https://home.example.test/callback?fixed=1"],
                token_endpoint_auth_method: "client_secret_post",
            },
        ]),
        HOMELAB_AUTH_DASHBOARD_CLIENT_ID: "dashboard",
        HOMELAB_AUTH_RESEND_API_KEY: "test-only-not-sent",
        HOMELAB_AUTH_EMAIL_FROM: "Test <noreply@example.test>",
    };
}
describe("auth configuration boundaries", () => {
    test("accepts exact HTTPS callbacks including fixed query parameters", () => {
        const result = parseAuthConfiguration(environment());
        expect(result?.clients[0]?.redirect_uris).toEqual([
            "https://home.example.test/callback?fixed=1",
        ]);
        expect(result?.development).toBe(false);
    });
    test("fails closed without production identity configuration", () => {
        expect(() => parseAuthConfiguration({ NODE_ENV: "production" })).toThrow();
        expect(parseAuthConfiguration({ NODE_ENV: "development" })).toBeUndefined();
    });
    test("rejects insecure origins, databases, keys and unrelated RP IDs", () => {
        for (const [key, value] of [
            ["HOMELAB_AUTH_ISSUER", "http://identity.example.test"],
            ["HOMELAB_AUTH_ISSUER", "https://identity.example.test/?redirect=other"],
            ["HOMELAB_AUTH_DASHBOARD_ORIGIN", "https://other.test"],
            [
                "HOMELAB_AUTH_DATABASE_URL",
                "postgres://test:test@localhost/test?sslmode=require",
            ],
            ["HOMELAB_AUTH_ENCRYPTION_KEY", "invalid"],
            ["HOMELAB_AUTH_COOKIE_KEY", "short"],
            ["HOMELAB_AUTH_RESEND_API_KEY", ""],
        ]) {
            if (!key || value === undefined) throw new Error("Invalid fixture");
            expect(() =>
                parseAuthConfiguration({ ...environment(), [key]: value })
            ).toThrow();
        }
    });
    test("never enables development relaxations in production", () => {
        expect(() =>
            parseAuthConfiguration({
                ...environment(),
                HOMELAB_AUTH_DEVELOPMENT: "true",
                HOMELAB_AUTH_ISSUER: "http://localhost",
            })
        ).toThrow();
    });
});
