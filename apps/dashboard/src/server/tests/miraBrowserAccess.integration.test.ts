import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import {
    claimMiraBrowserAccess,
    closeMiraBrowserAccess,
    requireMiraBrowserAccess,
    requestMiraBrowserAccess,
} from "@homelab/mira/data/browserAccess";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

async function fixture(enabled = true) {
    const f = await operationFixture();
    const caller = (
        owner = "operator",
        verified = owner,
        kind: "human" | "automation" = "human",
        fresh = true
    ) =>
        appRouter.createCaller({
            operations: f,
            principal: { kind, id: owner, capabilities },
            ...(fresh
                ? {
                      verifyHuman: () =>
                          Promise.resolve({ kind, id: verified, capabilities }),
                  }
                : {}),
        }).mira;
    const api = caller();
    const context = { client: f.client, owner: "operator", actor: "human:operator" };
    if (enabled)
        await setMiraEnabled(context, {
            key: "computer:browser",
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
    const chat = await api.conversations.create({ title: "Synthetic browser access" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Synthetic browser task",
        attachmentIds: [],
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected synthetic run.");
    const worker = {
        ...context,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    const request = {
        runId: run.id,
        origins: ["https://example.test"],
        initialUrl: "https://example.test/start",
        mode: "control" as const,
    };
    return { ...f, caller, api, context, worker, run, chat, request };
}

test("browser grants require fresh human identity and never reveal private executor claims", async () => {
    const f = await fixture();
    try {
        await rejects(
            f.caller("operator", "other").browser.request(f.request),
            /account changed/
        );
        await rejects(
            f.caller("operator", "operator", "human", false).browser.request(f.request),
            /verified operator/
        );
        await rejects(
            f.caller("operator", "operator", "automation").browser.request(f.request),
            /signed-in operator/
        );
        await rejects(
            requestMiraBrowserAccess(f.worker, f.request),
            /signed-in operator/
        );
        await rejects(f.caller("other").browser.request(f.request));
        const grant = await f.api.browser.request(f.request);
        expect(grant.state).toBe("pending");
        expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(f.run.deadlineAt! + 1000);
        await rejects(claimMiraBrowserAccess(f.context, grant.id));
        await rejects(claimMiraBrowserAccess({ ...f.worker, owner: "other" }, grant.id));
        await rejects(
            claimMiraBrowserAccess(
                {
                    ...f.worker,
                    run: { ...f.worker.run, leaseToken: crypto.randomUUID() },
                },
                grant.id
            )
        );
        const claim = await claimMiraBrowserAccess(f.worker, grant.id);
        expect(claim.policy).toMatchObject({
            origins: f.request.origins,
            mode: "control",
        });
        const permit = await requireMiraBrowserAccess(f.worker, {
            id: claim.id,
            hostToken: claim.hostToken,
            mode: "control",
        });
        expect(permit.validForMs).toBeGreaterThan(0);
        expect(permit.validForMs).toBeLessThanOrEqual(5000);
        const listed = await f.api.browser.list({ runId: f.run.id });
        expect(listed).toMatchObject([{ id: grant.id, state: "active" }]);
        for (const secret of [claim.hostToken, f.run.leaseToken, "executable"]) {
            expect(JSON.stringify(listed)).not.toContain(secret);
        }
        expect(await f.caller("other").browser.list()).toEqual([]);
        const audit = await f.client<
            { action: string; target: string }[]
        >`SELECT action,target FROM mira_audit WHERE action LIKE 'browser.%'`;
        expect([...audit]).toEqual([
            { action: "browser.access_requested", target: grant.id },
        ]);
    } finally {
        await f.close();
    }
});

test("browser policy rejects credentials, alternate schemes, duplicate or noncanonical origins and arbitrary worker options", async () => {
    const f = await fixture();
    try {
        for (const invalid of [
            { origins: ["https://example.test/"] },
            { origins: ["https://example.test", "https://example.test"] },
            { origins: ["https://*.example.test"] },
            { origins: ["https://user:secret@example.test"] },
            { initialUrl: "https://elsewhere.test/" },
            { initialUrl: "file:///etc/passwd" },
            { initialUrl: "https://user:secret@example.test/" },
            { initialUrl: "https://example.test/\nprivate" },
            { executable: "/bin/sh" },
            { profile: "/home/operator" },
        ])
            await rejects(f.api.browser.request({ ...f.request, ...invalid }));
        expect(await f.api.browser.list()).toEqual([]);
    } finally {
        await f.close();
    }
});

test("browser feature defaults off and automatic jobs cannot receive manual browser grants", async () => {
    const f = await fixture(false);
    try {
        await rejects(f.api.browser.request(f.request), /Enable browser access/);
        await setMiraEnabled(f.context, {
            key: "computer:browser",
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
        await f.client`UPDATE mira_runs SET manual=false WHERE id=${f.run.id}`;
        await rejects(f.api.browser.request(f.request), /manual job/);
    } finally {
        await f.close();
    }
});

test("browser request and host claim are serialized, view permission cannot become control", async () => {
    const f = await fixture();
    try {
        const outcomes = await Promise.allSettled([
            f.api.browser.request({ ...f.request, mode: "view" }),
            f.api.browser.request({ ...f.request, mode: "view" }),
        ]);
        expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const grants = await f.api.browser.list();
        const grant = grants[0]!;
        const claims = await Promise.allSettled([
            claimMiraBrowserAccess(f.worker, grant.id),
            claimMiraBrowserAccess(f.worker, grant.id),
        ]);
        expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const successful = claims.find((r) => r.status === "fulfilled")!;
        if (successful.status !== "fulfilled") throw new Error("Expected claim");
        const { id, hostToken } = successful.value;
        await requireMiraBrowserAccess(f.worker, { id, hostToken, mode: "view" });
        await rejects(
            requireMiraBrowserAccess(f.worker, { id, hostToken, mode: "control" })
        );
        await rejects(
            requireMiraBrowserAccess(f.worker, {
                id,
                hostToken: crypto.randomUUID(),
                mode: "view",
            })
        );
    } finally {
        await f.close();
    }
});

test("stop denies immediately but only the original host can release a claimed slot after cleanup", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.browser.request(f.request);
        const claim = await claimMiraBrowserAccess(f.worker, grant.id);
        const token = { id: grant.id, hostToken: claim.hostToken };
        await f.caller("other").browser.stop({ id: grant.id });
        await requireMiraBrowserAccess(f.worker, { ...token, mode: "control" });
        await f
            .caller("operator", "operator", "human", false)
            .browser.stop({ id: grant.id });
        await f.api.browser.stop({ id: grant.id });
        expect(await f.api.browser.list()).toMatchObject([
            { state: "stopping", origins: [], initialUrl: null },
        ]);
        await rejects(requireMiraBrowserAccess(f.worker, { ...token, mode: "view" }));
        await rejects(f.api.browser.request(f.request), /cleanup/);
        await rejects(closeMiraBrowserAccess(f.context, token));
        await closeMiraBrowserAccess({ ...f.worker, owner: "other" }, token);
        await closeMiraBrowserAccess(f.worker, {
            ...token,
            hostToken: crypto.randomUUID(),
        });
        await closeMiraBrowserAccess(
            { ...f.worker, run: { ...f.worker.run, leaseToken: crypto.randomUUID() } },
            token
        );
        await rejects(f.api.browser.request(f.request), /cleanup/);
        await closeMiraBrowserAccess(f.worker, token);
        await closeMiraBrowserAccess(f.worker, token);
        const replacement = await f.api.browser.request(f.request);
        expect(replacement.state).toBe("pending");
    } finally {
        await f.close();
    }
});

test.each(["autonomy", "computer:browser"])(
    "pause/resume of %s never resurrects a claimed browser",
    async (key) => {
        const f = await fixture();
        try {
            const grant = await f.api.browser.request(f.request);
            const claim = await claimMiraBrowserAccess(f.worker, grant.id);
            const token = { id: grant.id, hostToken: claim.hostToken };
            const version = key === "autonomy" ? 1 : 2;
            await setMiraEnabled(f.context, {
                key,
                version,
                enabled: false,
                reason: "Synthetic pause",
                until: null,
            });
            await rejects(requireMiraBrowserAccess(f.worker, { ...token, mode: "view" }));
            await setMiraEnabled(f.context, {
                key,
                version: version + 1,
                enabled: true,
                reason: null,
                until: null,
            });
            await rejects(requireMiraBrowserAccess(f.worker, { ...token, mode: "view" }));
            await rejects(f.api.browser.request(f.request), /cleanup/);
            await closeMiraBrowserAccess(f.worker, token);
            const replacement = await f.api.browser.request(f.request);
            expect(replacement.state).toBe("pending");
        } finally {
            await f.close();
        }
    }
);

test.each(["cancel", "finished", "lease", "heartbeat", "budget", "expired", "deleted"])(
    "browser access is revoked by %s while cleanup can still complete",
    async (change) => {
        const f = await fixture();
        try {
            const grant = await f.api.browser.request(f.request);
            const claim = await claimMiraBrowserAccess(f.worker, grant.id);
            const token = { id: grant.id, hostToken: claim.hostToken };
            if (change === "cancel")
                await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
            if (change === "finished")
                await f.client`UPDATE mira_runs SET state='completed' WHERE id=${f.run.id}`;
            if (change === "lease")
                await f.client`UPDATE mira_runs SET lease_token=${crypto.randomUUID()} WHERE id=${f.run.id}`;
            if (change === "heartbeat")
                await f.client`UPDATE mira_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.run.id}`;
            if (change === "budget")
                await f.client`UPDATE mira_runs SET started_at=clock_timestamp()-interval '1 day' WHERE id=${f.run.id}`;
            if (change === "expired")
                await f.client`UPDATE mira_browser_access SET created_at=clock_timestamp()-interval '6 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=${grant.id}`;
            if (change === "deleted")
                await f.client`UPDATE mira_conversations SET deleted_at=clock_timestamp() WHERE id=${f.chat.id}`;
            await rejects(requireMiraBrowserAccess(f.worker, { ...token, mode: "view" }));
            expect(await f.api.browser.list()).toMatchObject([{ state: "unavailable" }]);
            await closeMiraBrowserAccess(f.worker, token);
            expect(await f.api.browser.list()).toMatchObject([
                { state: "closed", origins: [], initialUrl: null },
            ]);
        } finally {
            await f.close();
        }
    }
);

test("unclaimed expiration can be replaced and deleting a finished chat scrubs policy without pretending cleanup", async () => {
    const f = await fixture();
    try {
        const old = await f.api.browser.request(f.request);
        await f.client`UPDATE mira_browser_access SET created_at=clock_timestamp()-interval '6 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=${old.id}`;
        const current = await f.api.browser.request(f.request);
        const claim = await claimMiraBrowserAccess(f.worker, current.id);
        await rejects(claimMiraBrowserAccess(f.worker, old.id));
        await f.client`UPDATE mira_runs SET state='completed' WHERE id=${f.run.id}`;
        const [conversation] = await f.client<
            { version: number }[]
        >`SELECT version FROM mira_conversations WHERE id=${f.chat.id}`;
        await f.api.conversations.change({
            id: f.chat.id,
            version: conversation!.version,
            action: "delete",
        });
        expect(await f.api.browser.list()).toMatchObject([
            { state: "stopping", origins: [], initialUrl: null },
            { state: "closed", origins: [], initialUrl: null },
        ]);
        await closeMiraBrowserAccess(f.worker, {
            id: current.id,
            hostToken: claim.hostToken,
        });
    } finally {
        await f.close();
    }
});

test("stopping an unclaimed reservation is final and repeated requests respect the hourly ceiling", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.browser.request(f.request);
        await f.api.browser.stop({ id: grant.id });
        await rejects(claimMiraBrowserAccess(f.worker, grant.id));
        await f.client`INSERT INTO mira_browser_access(id,owner,run_id,run_lease,controls,mode,state,closed_at,created_at,expires_at)
            SELECT gen_random_uuid(),owner,run_id,run_lease,controls,mode,'closed',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 minute' FROM mira_browser_access CROSS JOIN generate_series(1,19) WHERE id=${grant.id}`;
        await rejects(f.api.browser.request(f.request), /request limit/);
    } finally {
        await f.close();
    }
});
