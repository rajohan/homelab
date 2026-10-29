import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import { openMiraBrowserSession } from "@homelab/mira/data/browserHost";
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

function runtime() {
    const controller = new AbortController(),
        calls: string[] = [];
    let fail = false;
    const open = () =>
        Promise.resolve({
            signal: controller.signal,
            observe: (): Promise<never> =>
                Promise.reject(new Error("No image fixture is needed.")),
            navigate: (url: unknown) => {
                calls.push("navigate");
                return Promise.resolve({ url: String(url) });
            },
            act: () => {
                calls.push("act");
                return Promise.resolve({ effect: "unverified" as const });
            },
            close: () => {
                calls.push("close");
                controller.abort();
                return fail
                    ? Promise.reject(new Error("Synthetic cleanup failure"))
                    : Promise.resolve();
            },
        });
    return {
        open,
        calls,
        fail: () => {
            fail = true;
        },
    };
}

test("supervised host consumes a grant once, snapshots its owner and releases after human stop", async () => {
    const f = await fixture(),
        native = runtime(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        const original = { ...f.worker, run: { ...f.worker.run } };
        const session = await openMiraBrowserSession(
            original,
            grant.id,
            {},
            owner.signal,
            native.open
        );
        original.owner = "other";
        original.run.leaseToken = crypto.randomUUID();
        await rejects(
            openMiraBrowserSession(f.worker, grant.id, {}, owner.signal, native.open)
        );
        await session.navigate(f.request.initialUrl, owner.signal);
        await f.api.browser.stop({ id: grant.id });
        await rejects(
            session.navigate(f.request.initialUrl, owner.signal),
            /Browser access stopped/
        );
        await session.closed;
        expect(native.calls).toEqual(["navigate", "close"]);
        expect(await f.api.browser.list()).toMatchObject([
            { id: grant.id, state: "closed", initialUrl: null, origins: [] },
        ]);
        const rows = await f.client<
            { action: string }[]
        >`SELECT action FROM mira_audit WHERE action='browser.access_closed'`;
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(session)).not.toContain(f.run.leaseToken);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("view-only database authority denies native input and retires its session", async () => {
    const f = await fixture(),
        native = runtime(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request({ ...f.request, mode: "view" });
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            {},
            owner.signal,
            native.open
        );
        await rejects(
            session.act({ action: "click" }, owner.signal),
            /Browser access stopped/
        );
        expect(native.calls).toEqual(["close"]);
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("unconfirmed native startup and cleanup keep the durable slot reserved", async () => {
    for (const failure of ["startup", "cleanup"]) {
        const f = await fixture(),
            native = runtime(),
            owner = new AbortController();
        try {
            const grant = await f.api.browser.request(f.request);
            if (failure === "startup") {
                await rejects(
                    openMiraBrowserSession(f.worker, grant.id, {}, owner.signal, () =>
                        Promise.reject(new Error("Synthetic startup failure"))
                    ),
                    /cleanup could not be confirmed/
                );
            } else {
                const session = await openMiraBrowserSession(
                    f.worker,
                    grant.id,
                    {},
                    owner.signal,
                    native.open
                );
                native.fail();
                await rejects(session.close(), /cleanup could not be confirmed/);
            }
            await f.api.browser.stop({ id: grant.id });
            expect(await f.api.browser.list()).toMatchObject([{ state: "stopping" }]);
            await rejects(f.api.browser.request(f.request), /finish browser cleanup/);
        } finally {
            owner.abort();
            await f.close();
        }
    }
});

test("idle host detects a revoked run and closes without another browser command", async () => {
    const f = await fixture(),
        native = runtime(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            {},
            owner.signal,
            native.open
        );
        await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
        await session.closed;
        expect(native.calls).toEqual(["close"]);
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        owner.abort();
        await f.close();
    }
});
