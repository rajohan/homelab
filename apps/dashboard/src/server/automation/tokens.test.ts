import { expect, test } from "bun:test";

import { digestAutomationToken, issueAutomationToken, sameTokenDigest } from "./tokens";

test("automation credentials are independent, purpose-bound and hash-only", () => {
    const first = issueAutomationToken(),
        second = issueAutomationToken();
    expect(first.token).toMatch(/^hlb_[a-f0-9-]{36}\.[\w-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.digest).not.toContain(first.token);
    expect(sameTokenDigest(digestAutomationToken(first.token), first.digest)).toBe(true);
    expect(sameTokenDigest(second.digest, first.digest)).toBe(false);
    expect(sameTokenDigest(first.digest, "invalid")).toBe(false);
});
