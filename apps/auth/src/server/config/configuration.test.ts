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
                redirect_uris: [
                    "https://home.example.test/auth/callback",
                    "https://home.example.test/callback?fixed=1",
                ],
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
            "https://home.example.test/auth/callback",
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

test("validates a file policy and rejects ambiguous legacy configuration", () => {
    const routes = [{ origin: "https://TOOLS.example.test:443/" }];
    expect(parseAuthConfiguration(environment(), { routes })?.routes[0]?.origin).toBe(
        "https://tools.example.test"
    );
    expect(() =>
        parseAuthConfiguration(environment(), {
            routes: [...routes, { origin: "https://tools.example.test" }],
        })
    ).toThrow("Duplicate protected route origins");
    expect(() =>
        parseAuthConfiguration({ ...environment(), HOMELAB_AUTH_ROUTES: "[]" })
    ).toThrow("Move HOMELAB_AUTH_ROUTES");
    for (const value of [
        null,
        [],
        {},
        { routes: [], typo: true },
        { routes: [{ origin: "http://public.example.com" }] },
    ])
        expect(() => parseAuthConfiguration(environment(), value)).toThrow();
});
test("rejects root-wide public prefixes without affecting segment prefixes", () => {
    for (const prefix of ["/", "//", "/assets"])
        expect(() =>
            parseAuthConfiguration(environment(), {
                routes: [
                    { origin: "https://tools.example.test", publicPrefixes: [prefix] },
                ],
            })
        ).toThrow();
    expect(
        parseAuthConfiguration(environment(), {
            routes: [
                { origin: "https://tools.example.test", publicPrefixes: ["/assets/"] },
            ],
        })?.routes[0]?.publicPrefixes
    ).toEqual(["/assets/"]);
});

test("requires the designated dashboard client to register the exact BFF callback", () => {
    for (const callback of [
        "https://home.example.test/callback",
        "https://home.example.test/auth/callback?fixed=1",
        "https://other.example.test/auth/callback",
    ]) {
        const input = environment();
        input.HOMELAB_AUTH_CLIENTS = JSON.stringify([
            {
                client_id: "dashboard",
                client_name: "Dashboard",
                client_secret: "test-client-secret-not-production-32",
                redirect_uris: [callback],
                token_endpoint_auth_method: "client_secret_basic",
            },
            {
                client_id: "other",
                client_name: "Other",
                client_secret: "test-client-secret-not-production-32",
                redirect_uris: ["https://home.example.test/auth/callback"],
                token_endpoint_auth_method: "client_secret_post",
            },
        ]);
        expect(() => parseAuthConfiguration(input)).toThrow(
            "The dashboard client must register its exact /auth/callback URL"
        );
    }
});

test("rejects ICANN and private public-suffix RP IDs before startup", () => {
    for (const rpId of ["com", "co.uk", "github.io", "appspot.com", "test"]) {
        const input = environment();
        input.HOMELAB_AUTH_ISSUER = `https://identity.example.${rpId}`;
        input.HOMELAB_AUTH_DASHBOARD_ORIGIN = `https://home.example.${rpId}`;
        input.HOMELAB_AUTH_RP_ID = rpId;
        input.HOMELAB_AUTH_CLIENTS = JSON.stringify([
            {
                client_id: "dashboard",
                client_name: "Dashboard",
                client_secret: "test-client-secret-not-production-32",
                redirect_uris: [`https://home.example.${rpId}/auth/callback`],
                token_endpoint_auth_method: "client_secret_post",
            },
        ]);
        expect(() => parseAuthConfiguration(input)).toThrow("Invalid WebAuthn RP ID");
    }
});
test("allows registrable RP IDs, subdomains and the explicit localhost development case", () => {
    for (const rpId of [
        "example.com",
        "example.co.uk",
        "account.github.io",
        "account.appspot.com",
        "login.example.test",
        "localhost",
    ]) {
        const input = environment();
        const local = rpId === "localhost";
        const issuer = local ? "http://localhost:3100" : `https://identity.${rpId}`;
        const dashboard = local ? "http://localhost:3101" : `https://home.${rpId}`;
        if (local) {
            input.NODE_ENV = "development";
            input.HOMELAB_AUTH_DEVELOPMENT = "true";
        }
        input.HOMELAB_AUTH_ISSUER = issuer;
        input.HOMELAB_AUTH_DASHBOARD_ORIGIN = dashboard;
        input.HOMELAB_AUTH_RP_ID = rpId;
        input.HOMELAB_AUTH_CLIENTS = JSON.stringify([
            {
                client_id: "dashboard",
                client_name: "Dashboard",
                client_secret: "test-client-secret-not-production-32",
                redirect_uris: [dashboard + "/auth/callback"],
                token_endpoint_auth_method: "client_secret_post",
            },
        ]);
        expect(parseAuthConfiguration(input)?.rpId).toBe(rpId);
    }
});

test("accepts one mailbox or a simple display name and rejects malformed senders", () => {
    for (const from of [
        "noreply@example.test",
        "Homelab Notifications <noreply@example.test>",
        "Équipe <notify+auth@example.test>",
    ]) {
        expect(
            parseAuthConfiguration({ ...environment(), HOMELAB_AUTH_EMAIL_FROM: from })
                ?.emailFrom
        ).toBe(from);
    }
    for (const from of [
        "not-an-address",
        "Name <not-an-address>",
        "Name <>",
        " <sender@example.test>",
        "Name <sender@example.test> trailing",
        "a@example.test,b@example.test",
        "Name\r\nBcc: other@example.test <sender@example.test>",
        "Name <a@example.test> <b@example.test>",
    ]) {
        expect(() =>
            parseAuthConfiguration({ ...environment(), HOMELAB_AUTH_EMAIL_FROM: from })
        ).toThrow("Invalid sender address");
    }
});

test("requires secure, session-bound back-channel endpoints and preserves client groups", () => {
    const input = environment();
    const clients = JSON.parse(input.HOMELAB_AUTH_CLIENTS ?? "[]") as Record<
        string,
        unknown
    >[];
    const client = clients[0];
    if (!client) throw new Error("Missing test client");
    client.groups = ["operators"];
    client.backchannel_logout_uri = "https://home.example.test/auth/logout/backchannel";
    client.backchannel_logout_session_required = true;
    const parse = () =>
        parseAuthConfiguration({
            ...input,
            HOMELAB_AUTH_CLIENTS: JSON.stringify(clients),
        });
    expect(parse()?.clientGroups?.dashboard).toEqual(["operators"]);
    expect(parse()?.clients[0]?.groups).toBeUndefined();
    for (const uri of [
        "http://home.example.test/logout",
        "https://user:password@home.example.test/logout",
        "https://home.example.test/logout#fragment",
    ]) {
        client.backchannel_logout_uri = uri;
        expect(parse).toThrow();
    }
    client.backchannel_logout_uri = "https://home.example.test/logout";
    client.backchannel_logout_session_required = false;
    expect(parse).toThrow();
    delete client.backchannel_logout_session_required;
    expect(parse).toThrow("session-bound");
    delete client.backchannel_logout_uri;
    client.backchannel_logout_session_required = true;
    expect(parse).toThrow("session-bound");
});
