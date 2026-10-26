import { expect, test } from "bun:test";

import { issueComputerCredential, readComputerCredential } from "./credentials";

test("computer credentials are random, purpose-specific and stored only as fixed digests", () => {
    const id = crypto.randomUUID();
    const pair = issueComputerCredential("pair", id);
    const device = issueComputerCredential("device", id);
    expect(pair.token).not.toEqual(issueComputerCredential("pair", id).token);
    expect(pair.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(readComputerCredential(pair.token, "pair")).toEqual({
        id,
        digest: pair.digest,
    });
    expect(readComputerCredential(device.token, "device")).toEqual({
        id,
        digest: device.digest,
    });
    expect(readComputerCredential(pair.token, "device")).toBeNull();
    expect(readComputerCredential(device.token, "pair")).toBeNull();
    for (const token of [
        "",
        "x".repeat(10_000),
        pair.token + " ",
        pair.token.replace(id, "../owner"),
        pair.token.replace("mira_pair_", "hlb_"),
    ])
        expect(readComputerCredential(token, "pair")).toBeNull();
});
