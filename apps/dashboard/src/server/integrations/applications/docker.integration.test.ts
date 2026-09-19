import { expect, test } from "bun:test";

import { createApplicationFixture } from "../../testing/applications";
import { expectOperationFailure } from "../../testing/operations";
import { performApplicationAction } from "./actions";
import { createDockerPort } from "./docker";
import {
    collectApplications,
    filterApplicationInventory,
    mapDockerApplication,
} from "./inventory";
import { selectionRevision, selectApplications } from "./selection";

test("Docker discovery strips secret fields, retains unavailable identities and reapplies current allowlists", async () => {
    const fixture = createApplicationFixture();
    const signal = AbortSignal.timeout(3000);
    const connect = () => createDockerPort(fixture.target, {});
    try {
        const inventory = await collectApplications([fixture.target], connect, signal);
        expect(inventory.hosts[0]?.applications).toHaveLength(2);
        expect(JSON.stringify(inventory)).not.toContain("PRIVATE_KEY");
        expect(JSON.stringify(inventory)).not.toContain("Labels");
        expect(inventory.hosts[0]?.applications[0]).toMatchObject({
            networks: ["demo_default"],
            ports: [{ container: "8080/tcp", hostPort: "18080" }],
            mounts: [{ readOnly: false }],
        });
        fixture.behavior.unavailable = true;
        const unavailable = await collectApplications(
            [fixture.target],
            connect,
            signal,
            inventory
        );
        expect(unavailable.hosts[0]?.available).toBe(false);
        expect(unavailable.hosts[0]?.applications).toHaveLength(2);
        expect(() =>
            selectApplications(unavailable, "demo", { kind: "project", target: "demo" })
        ).toThrow("unavailable");
        expect(filterApplicationInventory(inventory, [])?.hosts).toEqual([]);
        expect(
            filterApplicationInventory(inventory, [
                { ...fixture.target, projects: ["other"] },
            ])?.hosts[0]?.applications
        ).toEqual([]);
        expect(filterApplicationInventory(null, [fixture.target])).toBeNull();
    } finally {
        await fixture.close();
    }
});

test("project restart stops dependents first, waits for readiness and never retargets stale identities", async () => {
    const fixture = createApplicationFixture(),
        signal = AbortSignal.timeout(3000);
    const port = createDockerPort(fixture.target, {});
    const selection = { kind: "project" as const, target: "demo" };
    const revision = () =>
        selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(fixture.target, detail)
            ),
            selection
        );
    try {
        const intent = { selection, operation: "restart" as const, revision: revision() };
        await performApplicationAction(fixture.target, port, intent, signal);
        expect(fixture.calls).toEqual([
            "stop:web",
            "stop:database",
            "start:database",
            "start:web",
        ]);
        await expectOperationFailure(
            performApplicationAction(fixture.target, port, intent, signal),
            "changed"
        );
        expect(fixture.calls).toHaveLength(4);
        fixture.calls.length = 0;
        await performApplicationAction(
            fixture.target,
            port,
            { ...intent, revision: revision(), operation: "stop" },
            signal
        );
        expect(fixture.calls).toEqual(["stop:web", "stop:database"]);
        fixture.calls.length = 0;
        await performApplicationAction(
            fixture.target,
            port,
            { ...intent, revision: revision(), operation: "start" },
            signal
        );
        expect(fixture.calls).toEqual(["start:database", "start:web"]);
    } finally {
        await fixture.close();
    }
});

test("dependency failures, changed project membership and aborted intents prevent unsafe writes", async () => {
    const fixture = createApplicationFixture(),
        signal = AbortSignal.timeout(3000);
    const port = createDockerPort(fixture.target, {}),
        selection = { kind: "project" as const, target: "demo" };
    const revision = () =>
        selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(fixture.target, detail)
            ),
            selection
        );
    try {
        const database = fixture.containers.get("a".repeat(64)),
            web = fixture.containers.get("b".repeat(64));
        if (!database || !web) throw new Error("Missing fixture");
        database.Config.Labels = {
            ...database.Config.Labels,
            "com.docker.compose.depends_on": "web:service_started:false",
        };
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                { selection, revision: revision(), operation: "start" },
                signal
            ),
            "cycle"
        );
        expect(fixture.calls).toEqual([]);
        delete database.Config.Labels["com.docker.compose.depends_on"];
        database.State.Health = { Status: "unhealthy" };
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                { selection, revision: revision(), operation: "start" },
                signal
            ),
            "ready"
        );
        expect(fixture.calls).toEqual(["start:database"]);
        fixture.calls.length = 0;
        web.Config.Labels = {
            ...web.Config.Labels,
            "com.docker.compose.project": "outside",
        };
        await expectOperationFailure(port.inspect(web.Id, signal), "outside");
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                { selection, revision: revision(), operation: "stop" },
                signal
            ),
            "outside"
        );
        expect(fixture.calls).toEqual([]);
        for (const option of ["redirect", "large", "unavailable"] as const) {
            fixture.behavior[option] = true;
            const failure = await port.list(signal).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect(String(failure)).not.toContain("private provider");
            fixture.behavior[option] = false;
        }
        expect(() =>
            createDockerPort(
                { ...fixture.target, tls: { ca: "A", certificate: "B", key: "C" } },
                {}
            )
        ).toThrow("credentials");
    } finally {
        await fixture.close();
    }
});
