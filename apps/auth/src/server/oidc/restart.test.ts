import { expect, test } from "bun:test";

import { signInRestartTarget } from "./restart";

test("expired sign-ins return only to one registered origin, without protocol state", () => {
    const configuration = {
        issuer: "https://auth.example.test",
        clients: [
            {
                client_id: "app",
                redirect_uris: ["https://app.example.test/callback?provider=example"],
            },
            {
                client_id: "ambiguous",
                redirect_uris: [
                    "https://one.example.test/callback",
                    "https://two.example.test/callback",
                ],
            },
            { client_id: "self", redirect_uris: ["https://auth.example.test/callback"] },
        ],
    };
    expect(signInRestartTarget(configuration, "app", ["admins"])).toBe(
        "https://app.example.test/"
    );
    for (const client of [
        null,
        "https://attacker.example",
        "missing",
        "ambiguous",
        "self",
    ]) {
        expect(signInRestartTarget(configuration, client, ["admins"])).toBe(
            "https://auth.example.test/account"
        );
    }
    expect(signInRestartTarget(configuration, "app", [])).toBe(
        "https://auth.example.test/account"
    );
    expect(
        signInRestartTarget({ ...configuration, clients: [] }, "app", ["admins"])
    ).toBe("https://auth.example.test/account");
});
