import { expect, test } from "bun:test";

import { readUpdateSources } from "../integrations/updates/inventory";
import { restartStatusJob } from "../integrations/updates/restart";
import { recordRestartObservation } from "../integrations/updates/restartObservation";
import type { JobExecution } from "../jobs/types";
import { operationFixture, expectOperationFailure } from "../testing/operations";
import { previewUpdateTargets } from "../testing/updates";

test("restart checks deduplicate application connections, clear after restart and retain explicit unknown failures", async () => {
    const fixture = await operationFixture();
    const sources = ["demo-main", "demo-sentinel"].map((id) => ({
        id,
        label: id,
        publisher: id,
    }));
    const calls: string[] = [];
    let required = true;
    const handler = restartStatusJob(previewUpdateTargets, (target) => {
        calls.push(target.source);
        if (target.source === "demo-sentinel")
            return Promise.reject(new Error("Synthetic unreachable host"));
        return Promise.resolve(required);
    });
    const context: JobExecution = {
        runId: crypto.randomUUID(),
        leaseToken: crypto.randomUUID(),
        signal: AbortSignal.timeout(5000),
        reportProgress: async () => {},
        commit: async (write) => {
            await fixture.client.begin(write);
            return true;
        },
    };
    try {
        expect(handler.definition.intervalSeconds).toBe(60);
        await handler.execute({}, context);
        expect(calls.toSorted()).toEqual(["demo-main", "demo-sentinel"]);
        expect(await readUpdateSources(fixture.client, sources)).toMatchObject([
            { restart: { required: true, stale: false } },
            { restart: { required: null, stale: false } },
        ]);
        required = false;
        await handler.execute({}, context);
        const cleared = await readUpdateSources(fixture.client, sources);
        expect(cleared[0]?.restart?.required).toBe(false);
        await fixture.client`UPDATE operation_snapshots SET captured_at=now() - interval '4 minutes' WHERE key='updates.restart:demo-main'`;
        const stale = await readUpdateSources(fixture.client, sources);
        expect(stale[0]?.restart?.stale).toBe(true);
        expect(
            await readUpdateSources(fixture.client, [
                { id: "absent", label: "Absent", publisher: "absent" },
            ])
        ).toMatchObject([{ restart: null }]);
        await expectOperationFailure(
            handler.execute({}, { ...context, commit: () => Promise.resolve(false) }),
            "ownership"
        );
        const aborted = AbortSignal.abort();
        await expectOperationFailure(
            handler.execute({}, { ...context, signal: aborted }),
            "aborted"
        );
    } finally {
        await fixture.close();
    }
});

test("a late restart probe or publication cannot overwrite a newer installation observation", async () => {
    const fixture = await operationFixture();
    try {
        const old = new Date(Date.now() - 10_000).toISOString();
        const latest = new Date().toISOString();
        await recordRestartObservation(fixture.client, "demo-main", true, latest);
        await recordRestartObservation(fixture.client, "demo-main", false, old);
        await recordRestartObservation(fixture.client, "demo-main", null, old);
        const [row] = await fixture.client<
            { value: { required: boolean; observedAt: string } }[]
        >`SELECT value FROM operation_snapshots WHERE key='updates.restart:demo-main'`;
        expect(row?.value).toEqual({ required: true, observedAt: latest });
    } finally {
        await fixture.close();
    }
});
