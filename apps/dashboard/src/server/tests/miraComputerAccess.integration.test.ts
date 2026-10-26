import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import {
    acceptMiraComputerAccess,
    pendingMiraComputerAccess,
    permitMiraComputerAccessLocally,
    requestMiraComputerAccess,
    requireMiraComputerAccess,
    stopMiraComputerAccessLocally,
} from "@homelab/mira/data/computerAccess";
import { connectMiraComputer, enrollMiraComputer } from "@homelab/mira/data/computers";
import { cancelRun } from "@homelab/mira/data/conversations";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { miraComputerReceiver } from "../mira/computerReceiver";
import { operationFixture } from "../testing/operations";

async function fixture() {
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
    const chat = await api.conversations.create({ title: "Synthetic computer session" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Synthetic action",
        attachmentIds: [],
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected a synthetic run.");
    const pair = await api.computers.pair({ label: "Synthetic PC" });
    const device = await enrollMiraComputer(f.client, pair.token, {
        installationId: crypto.randomUUID(),
        platform: "win32",
        version: "0.10.0",
    });
    const connection = await connectMiraComputer(f.client, device.credential);
    const request = {
        computerId: pair.id,
        computerVersion: 2,
        runId: run.id,
        mode: "control" as const,
    };
    const targetId = crypto.randomUUID();
    const worker = {
        ...context,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    const accept = (id: string) =>
        acceptMiraComputerAccess(f.client, device.credential, {
            id,
            connectionId: connection.connectionId,
            targetId,
        });
    const allow = (id: string, mode: "view" | "control" = "control") =>
        requireMiraComputerAccess(worker, { id, targetId, mode });
    return {
        ...f,
        caller,
        api,
        context,
        chat,
        run,
        pair,
        device,
        connection,
        request,
        targetId,
        worker,
        accept,
        allow,
    };
}

test("computer requests require fresh human verification and remain unusable before explicit local consent", async () => {
    const f = await fixture();
    try {
        await rejects(
            f.caller("operator", "other").computers.access.request(f.request),
            /account changed/
        );
        await rejects(
            f
                .caller("operator", "operator", "human", false)
                .computers.access.request(f.request),
            /verified operator/
        );
        await rejects(
            f
                .caller("operator", "operator", "automation")
                .computers.access.request(f.request),
            /signed-in operator/
        );
        await rejects(
            requestMiraComputerAccess(f.worker, f.request),
            /signed-in operator/
        );
        const grant = await f.api.computers.access.request(f.request);
        expect(grant.state).toBe("pending");
        expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(f.run.deadlineAt! + 1000);
        await rejects(f.allow(grant.id), /no longer available/);
        const pending = await pendingMiraComputerAccess(f.client, f.device.credential, {
            connectionId: f.connection.connectionId,
        });
        expect(pending.request).toMatchObject({
            id: grant.id,
            runId: f.run.id,
            mode: "control",
            state: "pending",
        });
        expect(await f.accept(grant.id)).toMatchObject({ id: grant.id, state: "active" });
        expect(await f.allow(grant.id)).toMatchObject({
            id: grant.id,
            targetId: f.targetId,
            connectionId: f.connection.connectionId,
            mode: "control",
        });
        const permit = await f.allow(grant.id);
        expect(permit.validForMs).toBeGreaterThan(0);
        expect(permit.validForMs).toBeLessThanOrEqual(5000);
        expect(
            await pendingMiraComputerAccess(f.client, f.device.credential, {
                connectionId: f.connection.connectionId,
            })
        ).toEqual({ request: null });
        await rejects(f.accept(grant.id), /local consent/);
        await rejects(
            acceptMiraComputerAccess(f.client, f.device.credential, {
                id: grant.id,
                connectionId: f.connection.connectionId,
                targetId: crypto.randomUUID(),
            })
        );
        const listed = await f.api.computers.access.list();
        expect(listed).toMatchObject([{ state: "active" }]);
        for (const secret of [
            f.run.leaseToken,
            f.device.credential,
            f.targetId,
            f.connection.connectionId,
        ])
            expect(JSON.stringify(listed)).not.toContain(secret);
        const audit = await f.client<
            { action: string; target: string }[]
        >`SELECT action,target FROM mira_audit WHERE action LIKE 'computer.access%' ORDER BY id`;
        expect(audit.map((row) => row.action)).toEqual([
            "computer.access_requested",
            "computer.access_accepted",
        ]);
        expect(JSON.stringify(audit)).not.toContain(f.targetId);
    } finally {
        await f.close();
    }
});

test("computer grants isolate owner, worker lease, device, target and view-only action scope", async () => {
    const f = await fixture();
    try {
        await rejects(
            f.caller("other").computers.access.request(f.request),
            /Computer changed/
        );
        const grant = await f.api.computers.access.request({
            ...f.request,
            mode: "view",
        });
        const otherPair = await f.api.computers.pair({ label: "Other PC" });
        const other = await enrollMiraComputer(f.client, otherPair.token, {
            installationId: crypto.randomUUID(),
            platform: "linux",
            version: "0.10.0",
        });
        const otherConnection = await connectMiraComputer(f.client, other.credential);
        await rejects(
            acceptMiraComputerAccess(f.client, other.credential, {
                id: grant.id,
                connectionId: otherConnection.connectionId,
                targetId: f.targetId,
            })
        );
        await stopMiraComputerAccessLocally(f.client, other.credential, { id: grant.id });
        await f.caller("other").computers.access.stop({ id: grant.id });
        expect(await f.caller("other").computers.access.list()).toEqual([]);
        await f.accept(grant.id);
        expect(await f.allow(grant.id, "view")).toMatchObject({ mode: "view" });
        await rejects(f.allow(grant.id, "control"));
        await rejects(
            requireMiraComputerAccess(
                { ...f.worker, owner: "other" },
                { id: grant.id, targetId: f.targetId, mode: "view" }
            )
        );
        await rejects(
            requireMiraComputerAccess(
                { ...f.worker, run: { id: f.run.id, leaseToken: crypto.randomUUID() } },
                { id: grant.id, targetId: f.targetId, mode: "view" }
            )
        );
        await rejects(
            requireMiraComputerAccess(f.worker, {
                id: grant.id,
                targetId: crypto.randomUUID(),
                mode: "view",
            })
        );
        await rejects(
            requireMiraComputerAccess(f.context, {
                id: grant.id,
                targetId: f.targetId,
                mode: "view",
            })
        );
    } finally {
        await f.close();
    }
});

test("stop needs no new MFA or version, is idempotent and wins concurrent local acceptance", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.computers.access.request(f.request);
        const withoutMfa = f.caller("operator", "operator", "human", false).computers
            .access;
        await Promise.allSettled([f.accept(grant.id), withoutMfa.stop({ id: grant.id })]);
        await withoutMfa.stop({ id: grant.id });
        await rejects(f.allow(grant.id));
        await rejects(f.accept(grant.id));
        expect(await f.api.computers.access.list()).toMatchObject([{ state: "stopped" }]);
        const audit = await f.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_audit WHERE action='computer.access_stopped' AND target=${grant.id}`;
        expect(audit[0]!.count).toBe(1);
        const next = await f.api.computers.access.request(f.request);
        expect(next.id).not.toBe(grant.id);
        await rejects(f.allow(next.id));
        await f.accept(next.id);
        await stopMiraComputerAccessLocally(f.client, f.device.credential, {
            id: next.id,
        });
        await rejects(f.allow(next.id));
    } finally {
        await f.close();
    }
});

test("one computer and one run can have only one pending or active request despite concurrency", async () => {
    const f = await fixture();
    try {
        const outcomes = await Promise.allSettled([
            f.api.computers.access.request(f.request),
            f.api.computers.access.request(f.request),
        ]);
        expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((row) => row.status === "rejected")).toHaveLength(1);
        const granted = outcomes.find((row) => row.status === "fulfilled")!;
        if (granted.status !== "fulfilled") throw new Error("Expected a request.");
        const otherPair = await f.api.computers.pair({ label: "Another PC" });
        const other = await enrollMiraComputer(f.client, otherPair.token, {
            installationId: crypto.randomUUID(),
            platform: "linux",
            version: "0.10.0",
        });
        await connectMiraComputer(f.client, other.credential);
        await rejects(
            f.api.computers.access.request({ ...f.request, computerId: otherPair.id }),
            /already pending/
        );
        const accepts = await Promise.allSettled([
            f.accept(granted.value.id),
            f.accept(granted.value.id),
        ]);
        expect(accepts.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        expect(accepts.filter((row) => row.status === "rejected")).toHaveLength(1);
    } finally {
        await f.close();
    }
});

test("reconnection, credential revocation and expiration cannot restore old grants", async () => {
    for (const mode of ["reconnect", "revoke", "credential", "connection"]) {
        const f = await fixture();
        try {
            const grant = await f.api.computers.access.request(f.request);
            await f.accept(grant.id);
            if (mode === "reconnect")
                await connectMiraComputer(f.client, f.device.credential);
            if (mode === "revoke")
                await f.api.computers.revoke({ id: f.pair.id, version: 2 });
            if (mode === "credential")
                await f.client`UPDATE mira_computers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.pair.id}`;
            if (mode === "connection")
                await f.client`UPDATE mira_computers SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.pair.id}`;
            await rejects(f.allow(grant.id));
            expect(await f.api.computers.access.list()).toMatchObject([
                { state: "unavailable" },
            ]);
            if (mode === "connection") {
                await connectMiraComputer(f.client, f.device.credential);
                await rejects(f.allow(grant.id));
            }
        } finally {
            await f.close();
        }
    }
});

test("run cancellation, worker loss, completion, budget and conversation deletion invalidate access", async () => {
    for (const mode of [
        "cancel",
        "lease",
        "replacement",
        "complete",
        "budget",
        "delete",
    ]) {
        const f = await fixture();
        try {
            const grant = await f.api.computers.access.request(f.request);
            await f.accept(grant.id);
            if (mode === "cancel") await cancelRun(f.context, f.run.id);
            if (mode === "lease")
                await f.client`UPDATE mira_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.run.id}`;
            if (mode === "replacement")
                await f.client`UPDATE mira_runs SET lease_token=${crypto.randomUUID()} WHERE id=${f.run.id}`;
            if (mode === "complete")
                await f.client`UPDATE mira_runs SET state='completed',finished_at=clock_timestamp() WHERE id=${f.run.id}`;
            if (mode === "budget")
                await f.client`UPDATE mira_runs SET started_at=clock_timestamp()-interval '1 hour' WHERE id=${f.run.id}`;
            if (mode === "delete")
                await f.client`UPDATE mira_conversations SET deleted_at=clock_timestamp() WHERE id=${f.chat.id}`;
            await rejects(f.allow(grant.id));
            expect(await f.api.computers.access.list()).toMatchObject([
                { state: "unavailable" },
            ]);
        } finally {
            await f.close();
        }
    }
});

test("pause then resume never revives a grant, including a manual chat session", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.computers.access.request(f.request);
        await f.accept(grant.id);
        await setMiraEnabled(f.context, {
            key: "autonomy",
            version: 1,
            enabled: false,
            reason: "Synthetic pause",
            until: null,
        });
        await rejects(f.allow(grant.id));
        await setMiraEnabled(f.context, {
            key: "autonomy",
            version: 2,
            enabled: true,
            reason: null,
            until: null,
        });
        await rejects(f.allow(grant.id));
        const next = await f.api.computers.access.request(f.request);
        expect(next.state).toBe("pending");
        await rejects(f.allow(next.id));
    } finally {
        await f.close();
    }
});

test("pending consent expires after a minute and total authority never extends past five minutes", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.computers.access.request(f.request);
        const original = grant.expiresAt;
        await f.client`UPDATE mira_computer_access SET created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()+interval '1 minute' WHERE id=${grant.id}`;
        await rejects(f.accept(grant.id));
        expect(
            await pendingMiraComputerAccess(f.client, f.device.credential, {
                connectionId: f.connection.connectionId,
            })
        ).toEqual({ request: null });
        const next = await f.api.computers.access.request(f.request);
        expect(next.id).not.toBe(grant.id);
        const accepted = await f.accept(next.id);
        expect(accepted.expiresAt).toBe(next.expiresAt);
        expect(Date.parse(accepted.expiresAt)).toBeLessThanOrEqual(
            Date.parse(original) + 1000
        );
        await f.client`UPDATE mira_computer_access SET created_at=clock_timestamp()-interval '6 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=${next.id}`;
        await rejects(f.allow(next.id));
        const history = await f.api.computers.access.list();
        expect(history.find((item) => item.id === next.id)?.state).toBe("expired");
        expect(history.find((item) => item.id === grant.id)?.state).toBe("stopped");
    } finally {
        await f.close();
    }
});

test("request quota bounds churn even when every earlier session was stopped", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.computers.access.request(f.request);
        await f.api.computers.access.stop({ id: grant.id });
        await f.client`INSERT INTO mira_computer_access(id,owner,computer_id,computer_version,connection_id,run_id,run_lease,controls,mode,state,expires_at,stopped_at)
            SELECT gen_random_uuid(),owner,computer_id,computer_version,connection_id,run_id,run_lease,controls,mode,'stopped',clock_timestamp()+interval '1 minute',clock_timestamp()
            FROM mira_computer_access CROSS JOIN generate_series(1,19) WHERE id=${grant.id}`;
        await rejects(f.api.computers.access.request(f.request), /request limit/);
        expect(await f.api.computers.access.list()).toHaveLength(20);
    } finally {
        await f.close();
    }
});

test("private HTTP consent uses device authentication and accepts no native paths or input commands", async () => {
    const f = await fixture();
    const receiver = miraComputerReceiver(f.client);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: receiver });
    const post = async (
        route: string,
        data: unknown,
        token = f.device.credential,
        headers: Record<string, string> = {}
    ) => {
        const response = await fetch(
            `http://127.0.0.1:${server.port}/api/mira/computers/access/${route}`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${token}`,
                    ...headers,
                },
                body: JSON.stringify(data),
            }
        );
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
        };
    };
    try {
        const grant = await f.api.computers.access.request(f.request);
        const connection = { connectionId: f.connection.connectionId };
        expect(await post("pending", connection)).toMatchObject({
            status: 200,
            body: { request: { id: grant.id } },
        });
        expect(await post("pending", connection, f.pair.token)).toMatchObject({
            status: 403,
        });
        expect(
            await post("pending", connection, f.device.credential, {
                origin: "https://synthetic.invalid",
            })
        ).toMatchObject({ status: 403 });
        const consent = { ...connection, id: grant.id, targetId: f.targetId };
        expect(await post("accept", { ...consent, executable: "/bin/sh" })).toMatchObject(
            { status: 400 }
        );
        expect(await post("accept", consent)).toMatchObject({ status: 200 });
        expect(await post("click", { id: grant.id, x: 1, y: 1 })).toMatchObject({
            status: 404,
        });
        expect(await post("stop", { id: grant.id })).toEqual({
            status: 200,
            body: { stopped: true },
        });
        await rejects(f.allow(grant.id));
    } finally {
        await server.stop(true);
        await f.close();
    }
});

test("automation definition and individual pause changes cannot silently extend an existing computer grant", async () => {
    for (const mode of ["definition", "pause", "integration"]) {
        const f = await fixture();
        try {
            const automationId = crypto.randomUUID();
            await f.client`INSERT INTO mira_automations(id,owner,title,prompt,kind,schedule,budget_seconds) VALUES(${automationId},'operator','Synthetic automation','Synthetic prompt','brief',${JSON.stringify({ kind: "event", event: mode === "integration" ? "agentmail" : "task_due" })}::text::jsonb,300)`;
            await f.client`INSERT INTO mira_switches(owner,key,enabled) VALUES('operator',${`automation:${automationId}`},true),('operator','integration:agentmail',true)`;
            await f.client`UPDATE mira_runs SET automation_id=${automationId} WHERE id=${f.run.id}`;
            const grant = await f.api.computers.access.request(f.request);
            await f.accept(grant.id);
            if (mode === "definition")
                await f.client`UPDATE mira_automations SET version=version+1 WHERE id=${automationId}`;
            else {
                const key =
                    mode === "pause"
                        ? `automation:${automationId}`
                        : "integration:agentmail";
                await setMiraEnabled(f.context, {
                    key,
                    version: 1,
                    enabled: false,
                    reason: "Synthetic pause",
                    until: null,
                });
                await rejects(f.allow(grant.id));
                await setMiraEnabled(f.context, {
                    key,
                    version: 2,
                    enabled: true,
                    reason: null,
                    until: null,
                });
            }
            await rejects(f.allow(grant.id));
        } finally {
            await f.close();
        }
    }
});

test("requesting access refuses an ended or foreign run and races safely with device revocation", async () => {
    const f = await fixture();
    try {
        await rejects(
            f.api.computers.access.request({ ...f.request, computerVersion: 1 }),
            /Computer changed/
        );
        await rejects(
            f.api.computers.access.request({ ...f.request, runId: crypto.randomUUID() }),
            /selected run/
        );
        const otherChat = await f
            .caller("other")
            .conversations.create({ title: "Another owner" });
        const otherRun = await f.caller("other").conversations.send({
            conversationId: otherChat.id,
            requestId: crypto.randomUUID(),
            text: "Synthetic",
            attachmentIds: [],
        });
        await claimMiraRun(f.client, crypto.randomUUID(), "general");
        await rejects(
            f.api.computers.access.request({ ...f.request, runId: otherRun.id }),
            /selected run/
        );
        const result = await Promise.allSettled([
            f.api.computers.access.request(f.request),
            f.api.computers.revoke({ id: f.pair.id, version: 2 }),
        ]);
        expect(result[1].status).toBe("fulfilled");
        const granted = result[0];
        if (granted.status === "fulfilled" && granted.value) {
            await rejects(f.allow(granted.value.id));
            await rejects(f.accept(granted.value.id));
        }
    } finally {
        await f.close();
    }
});

test("a deadline elapsed between validation and insertion returns a public precondition without a partial grant", async () => {
    for (const expires of ["run", "credential"]) {
        const f = await fixture();
        try {
            // Delay inside PostgreSQL after the earlier eligibility reads, before INSERT evaluates its timestamps.
            await f.client`CREATE SEQUENCE synthetic_access_insert_attempt`;
            await f.client`CREATE FUNCTION synthetic_access_insert_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('synthetic_access_insert_attempt'); PERFORM pg_sleep(1.25); RETURN NULL; END; $$`;
            await f.client`CREATE TRIGGER synthetic_access_insert_delay BEFORE INSERT ON mira_computer_access FOR EACH STATEMENT EXECUTE FUNCTION synthetic_access_insert_delay()`;
            await (expires === "run"
                ? f.client`UPDATE mira_runs SET started_at=clock_timestamp()-budget_seconds*interval '1 second'+interval '1 second' WHERE id=${f.run.id}`
                : f.client`UPDATE mira_computers SET expires_at=clock_timestamp()+interval '1 second' WHERE id=${f.pair.id}`);
            await rejects(f.api.computers.access.request(f.request), {
                code: "PRECONDITION_FAILED",
                message: "Computer access expired before it could be requested.",
            });
            const [attempt] = await f.client<
                { is_called: boolean }[]
            >`SELECT is_called FROM synthetic_access_insert_attempt`;
            expect(attempt!.is_called).toBe(true);
            expect(await f.api.computers.access.list()).toEqual([]);
            const audit = await f.client<
                { id: string }[]
            >`SELECT id FROM mira_audit WHERE action='computer.access_requested'`;
            expect(audit).toHaveLength(0);
        } finally {
            await f.close();
        }
    }
}, 10_000);

test("paired PC permits preserve exact generation, target, view scope and pause invalidation", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.computers.access.request({
            ...f.request,
            mode: "view",
        });
        const input = {
            id: grant.id,
            connectionId: f.connection.connectionId,
            targetId: f.targetId,
            mode: "view",
        };
        const permit = (
            change: Record<string, unknown> = {},
            token = f.device.credential
        ) => permitMiraComputerAccessLocally(f.client, token, { ...input, ...change });
        await rejects(permit(), /no longer available/);
        await f.accept(grant.id);
        const allowed = await permit();
        expect(allowed).toMatchObject(input);
        expect(allowed.validForMs).toBeGreaterThan(0);
        expect(allowed.validForMs).toBeLessThanOrEqual(5000);
        for (const change of [
            { id: crypto.randomUUID() },
            { targetId: crypto.randomUUID() },
            { connectionId: crypto.randomUUID() },
            { mode: "control" },
        ])
            await rejects(permit(change));
        await rejects(permit({}, "invalid"));
        const otherPair = await f.api.computers.pair({ label: "Other PC" });
        const other = await enrollMiraComputer(f.client, otherPair.token, {
            installationId: crypto.randomUUID(),
            platform: "win32",
            version: "0.10.0",
        });
        const otherConnection = await connectMiraComputer(f.client, other.credential);
        await rejects(
            permit({ connectionId: otherConnection.connectionId }, other.credential)
        );
        await f.api.computers.access.stop({ id: grant.id });
        await rejects(permit(), /no longer available/);
        const next = await f.api.computers.access.request(f.request);
        await f.accept(next.id);
        const active = { ...input, id: next.id, mode: "control" };
        expect(
            await permitMiraComputerAccessLocally(f.client, f.device.credential, active)
        ).toMatchObject(active);
        await cancelRun(f.context, f.run.id);
        await rejects(
            permitMiraComputerAccessLocally(f.client, f.device.credential, active)
        );
    } finally {
        await f.close();
    }
});

test("private permit HTTP route admits only a valid machine binding and reveals no run lease", async () => {
    const f = await fixture();
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: miraComputerReceiver(f.client),
    });
    try {
        const grant = await f.api.computers.access.request(f.request);
        await f.accept(grant.id);
        const input = {
            id: grant.id,
            connectionId: f.connection.connectionId,
            targetId: f.targetId,
            mode: "control",
        };
        const post = (body: unknown, headers: Record<string, string> = {}) =>
            fetch(new URL("/api/mira/computers/access/permit", server.url), {
                method: "POST",
                headers: {
                    authorization: `Bearer ${f.device.credential}`,
                    "content-type": "application/json",
                    ...headers,
                },
                body: JSON.stringify(body),
            });
        const response = await post(input);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const payload = await response.json();
        expect(payload).toMatchObject(input);
        expect(JSON.stringify(payload)).not.toContain(f.run.leaseToken);
        expect(
            await post(input, { origin: "https://public.example.test" })
        ).toMatchObject({ status: 403 });
        expect(await post({ ...input, executable: "/injected" })).toMatchObject({
            status: 400,
        });
        await connectMiraComputer(f.client, f.device.credential);
        expect(await post(input)).toMatchObject({ status: 403 });
    } finally {
        await server.stop(true);
        await f.close();
    }
});

test("pending consent exposes the original one-minute deadline even when discovered late", async () => {
    const f = await fixture();
    try {
        const grant = await f.api.computers.access.request(f.request);
        await f.client`UPDATE mira_computer_access SET created_at=clock_timestamp()-interval '55 seconds',expires_at=clock_timestamp()+interval '1 minute' WHERE id=${grant.id}`;
        const before = Date.now();
        const pending = await pendingMiraComputerAccess(f.client, f.device.credential, {
            connectionId: f.connection.connectionId,
        });
        expect(pending.request).not.toBeNull();
        const deadline = Date.parse(pending.request!.consentExpiresAt);
        expect(deadline - before).toBeGreaterThan(0);
        expect(deadline - before).toBeLessThanOrEqual(5000);
        expect(Date.parse(pending.request!.expiresAt) - deadline).toBeGreaterThan(50_000);
    } finally {
        await f.close();
    }
});
