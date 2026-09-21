import { expect, test } from "bun:test";

import { appRouter } from "../api/router";
import { authenticateAutomation } from "../automation/authentication";
import {
    changeAutomation,
    createAutomation,
    listAutomation,
    rotateAutomation,
} from "../automation/service";
import { expectOperationFailure, operationFixture } from "../testing/operations";

test("only a token hash persists and staged rotation preserves the predecessor until revocation", async () => {
    const fixture = await operationFixture();
    try {
        const account = await createAutomation(fixture.client, "human:test", {
            label: "Test client",
            capabilities: ["jobs:read"],
            expiresAt: null,
        });
        const principal = await authenticateAutomation(
            fixture.client,
            `Bearer ${account.token}`
        );
        expect(principal.capabilities).toEqual(["jobs:read"]);
        const stored = await fixture.client<
            Record<string, unknown>[]
        >`SELECT * FROM automation_credentials`;
        expect(JSON.stringify(stored)).not.toContain(account.token);
        const replacement = await rotateAutomation(fixture.client, "human:test", {
            id: account.id,
            version: 1,
            expiresAt: Date.now() + 60_000,
        });
        expect(
            await authenticateAutomation(fixture.client, `Bearer ${account.token}`)
        ).toBeDefined();
        expect(
            await authenticateAutomation(fixture.client, `Bearer ${replacement.token}`)
        ).toBeDefined();
        await changeAutomation(fixture.client, "human:test", {
            id: account.id,
            version: 2,
            kind: "revoke",
            credentialId: account.credentialId,
        });
        await expectOperationFailure(
            authenticateAutomation(fixture.client, `Bearer ${account.token}`),
            "valid automation token"
        );
        expect(
            await authenticateAutomation(fixture.client, `Bearer ${replacement.token}`)
        ).toBeDefined();
        const inventory = await listAutomation(fixture.client);
        expect(JSON.stringify(inventory)).not.toContain("digest");
    } finally {
        await fixture.close();
    }
});

test("disabling an account revokes every token and stale grant edits are rejected", async () => {
    const fixture = await operationFixture();
    try {
        const account = await createAutomation(fixture.client, "human:test", {
            label: "Client",
            capabilities: ["jobs:read"],
            expiresAt: null,
        });
        await changeAutomation(fixture.client, "human:test", {
            id: account.id,
            version: 1,
            kind: "capabilities",
            capabilities: ["infrastructure:read"],
        });
        const principal = await authenticateAutomation(
            fixture.client,
            `Bearer ${account.token}`
        );
        expect(principal.capabilities).toEqual(["infrastructure:read"]);
        await expectOperationFailure(
            changeAutomation(fixture.client, "human:test", {
                id: account.id,
                version: 1,
                kind: "disable",
            }),
            "account changed"
        );
        await changeAutomation(fixture.client, "human:test", {
            id: account.id,
            version: 2,
            kind: "disable",
        });
        await expectOperationFailure(
            authenticateAutomation(fixture.client, `Bearer ${account.token}`),
            "valid automation token"
        );
    } finally {
        await fixture.close();
    }
});

test("API grants cannot be escalated by machine tokens and human administration rechecks MFA", async () => {
    const fixture = await operationFixture();
    try {
        const machine = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "automation", id: "test", capabilities: ["jobs:read"] },
        });
        expect(await machine.jobs.list({})).toEqual({
            runs: [],
            nextCursor: null,
            nextSortCursor: null,
        });
        await expectOperationFailure(
            machine.jobs.run({
                action: "system.retention",
                requestId: Bun.randomUUIDv7(),
            }),
            "permission"
        );
        await expectOperationFailure(
            machine.automation.create({
                label: "Escalation",
                capabilities: ["jobs:run"],
                expiresAt: null,
            }),
            "verified operator"
        );
        const human = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities: [] },
            verifyHuman: () =>
                Promise.resolve({ kind: "human", id: "changed", capabilities: [] }),
        });
        await expectOperationFailure(
            human.automation.create({
                label: "Rejected",
                capabilities: ["jobs:read"],
                expiresAt: null,
            }),
            "account changed"
        );
        const inventory = await listAutomation(fixture.client);
        expect(inventory.accounts).toHaveLength(0);
    } finally {
        await fixture.close();
    }
});

test("expired tokens fail closed and per-account rate budgets survive token replacement", async () => {
    const fixture = await operationFixture();
    try {
        const account = await createAutomation(fixture.client, "human:test", {
            label: "Rate limited",
            capabilities: ["jobs:read"],
            expiresAt: null,
        });
        await fixture.client`UPDATE automation_credentials SET expires_at = now() - interval '1 second' WHERE id = ${account.credentialId}`;
        await expectOperationFailure(
            authenticateAutomation(fixture.client, `Bearer ${account.token}`),
            "valid automation token"
        );
        const replacement = await rotateAutomation(fixture.client, "human:test", {
            id: account.id,
            version: 1,
            expiresAt: null,
        });
        await fixture.client`INSERT INTO operation_rate_windows (key, count, expires_at) VALUES (${account.id}, 120, now() + interval '1 minute')`;
        await expectOperationFailure(
            authenticateAutomation(fixture.client, `Bearer ${replacement.token}`),
            "request limit"
        );
        await fixture.client`UPDATE operation_rate_windows SET expires_at = now() - interval '1 second'`;
        expect(
            await authenticateAutomation(fixture.client, `Bearer ${replacement.token}`)
        ).toBeDefined();
    } finally {
        await fixture.close();
    }
});
