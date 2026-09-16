import { expect, test } from "bun:test";

import { clientAllowed } from "./clientAccess";

const clients = [
    { client_id: "dashboard", redirect_uris: ["https://app.example.test/callback"] },
];

test("client access defaults to admins and rejects unregistered clients", () => {
    expect(clientAllowed({ clients }, ["admins"], "dashboard")).toBe(true);
    expect(clientAllowed({ clients }, ["members"], "dashboard")).toBe(false);
    expect(clientAllowed({ clients }, ["admins"], "missing")).toBe(false);
});

test("client access evaluates current membership against any currently permitted group", () => {
    const configuration = {
        clients,
        clientGroups: { dashboard: ["operators", "members"] },
    };
    expect(clientAllowed(configuration, ["admins"], "dashboard")).toBe(false);
    expect(clientAllowed(configuration, ["members"], "dashboard")).toBe(true);
    expect(clientAllowed(configuration, [], "dashboard")).toBe(false);
});
