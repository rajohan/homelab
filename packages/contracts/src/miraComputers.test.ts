import { expect, test } from "bun:test";

import * as v from "valibot";

import {
    miraComputerAccessAcceptSchema,
    miraComputerAccessRequestSchema,
} from "./miraComputers";

test("computer permission requests accept exact bounded scopes, never wildcard targets or extra authority", () => {
    const request = {
        computerId: crypto.randomUUID(),
        computerVersion: 2,
        runId: crypto.randomUUID(),
        mode: "view",
    };
    expect(v.safeParse(miraComputerAccessRequestSchema, request).success).toBe(true);
    for (const changed of [
        { ...request, mode: "all" },
        { ...request, computerVersion: 0 },
        { ...request, runId: "*" },
        { ...request, executable: "/bin/sh" },
    ])
        expect(v.safeParse(miraComputerAccessRequestSchema, changed).success).toBe(false);
    const accepted = {
        id: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        targetId: crypto.randomUUID(),
    };
    expect(v.safeParse(miraComputerAccessAcceptSchema, accepted).success).toBe(true);
    expect(
        v.safeParse(miraComputerAccessAcceptSchema, { ...accepted, targetId: "*" })
            .success
    ).toBe(false);
    expect(
        v.safeParse(miraComputerAccessAcceptSchema, { ...accepted, mode: "control" })
            .success
    ).toBe(false);
});
