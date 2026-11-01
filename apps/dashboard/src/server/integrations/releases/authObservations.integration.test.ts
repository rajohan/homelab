import { expect, test } from "bun:test";

import type { UpdateReport } from "@homelab/contracts/updates";

import { operationFixture } from "../../testing/operations";
import { authReleaseObservations } from "./authObservations";
import type { ReleaseDeploymentTarget } from "./deploymentConfiguration";
import {
    deploymentTestConnections,
    deploymentTestPlan,
    deploymentTestTarget,
} from "./deploymentFixtures";
import { deploymentDigest } from "./deploymentProtocol";

const connections = [
    ...deploymentTestConnections,
    {
        ...deploymentTestConnections[0]!,
        id: "edge",
        source: "edge",
        host: "auth.example.test",
    },
];
const target: ReleaseDeploymentTarget = {
    ...deploymentTestTarget,
    auth: {
        ...deploymentTestTarget,
        id: "auth",
        connection: "edge",
        mira: false,
        services: [{ name: "auth", app: "auth" }],
    },
};

async function fixture() {
    const state = await operationFixture();
    const observedAt = Math.floor(Date.now() / 1000) - 60;
    const seed = async (selected = target, version = "1.2.3", updatedAt = observedAt) => {
        const id = Bun.randomUUIDv7();
        const plan = deploymentTestPlan(selected, connections);
        plan.release.version = version;
        plan.release.images = plan.release.images.map((image) => ({
            ...image,
            reference: image.reference.replace("1.2.3", version),
        }));
        const progress = {
            stage: "main",
            submitted: true,
            auth: {
                id,
                state: "succeeded",
                phase: "complete",
                updatedAt,
                changesStarted: true,
                migrationStarted: true,
                requestHash: deploymentDigest({
                    id,
                    target: selected.auth,
                    release: plan.release,
                    expected: plan.authExpected,
                }),
                version,
                revision: plan.release.revision,
                containers: {
                    auth: {
                        ...plan.authExpected!.containers.auth!,
                        id: crypto.randomUUID().replaceAll("-", "").repeat(2),
                        image: plan.release.images.find((image) => image.app === "auth")!
                            .reference,
                    },
                },
            },
        };
        await state.client`INSERT INTO release_deployments(id,target,requested_by,request_key,confirmation_revision,configuration,plan,state,phase,receipt,finished_at)
            VALUES (${id},${selected.id},'fixture',${id},'fixture',${plan.configuration},${JSON.stringify(plan)}::text::jsonb,'failed','failed',${JSON.stringify(progress)}::text::jsonb,now())`;
        return id;
    };
    const read = (targets = [target]) =>
        authReleaseObservations({
            client: state.client,
            repository: "demo/homelab",
            sources: [{ id: "edge", label: "Auth", publisher: "fixture" }],
            targets,
            connections,
        });
    return { ...state, seed, read, observedAt };
}

test("a later pending or invalid Auth attempt preserves the preceding verified upgrade", async () => {
    const state = await fixture();
    try {
        await state.seed();
        const later = await state.seed(target, "1.2.4", state.observedAt + 1);
        const [record] = await state.client<
            { receipt: unknown }[]
        >`SELECT receipt FROM release_deployments WHERE id=${later}`;
        for (const status of ["waiting", "failed"]) {
            await state.client`UPDATE release_deployments SET state=${status},finished_at=${status === "waiting" ? null : new Date()},receipt=${JSON.stringify({ stage: "auth", submitted: false })}::text::jsonb WHERE id=${later}`;
            const items = await state.read();
            expect(items.map((item) => item.version)).toEqual(["1.2.3"]);
        }
        await state.client`UPDATE release_deployments SET receipt=jsonb_set(${JSON.stringify(record!.receipt)}::text::jsonb,'{auth,requestHash}','"invalid"'::jsonb) WHERE id=${later}`;
        const invalid = await state.read();
        expect(invalid.map((item) => item.version)).toEqual(["1.2.3"]);
    } finally {
        await state.close();
    }
});

test("only a complete container inventory supersedes a verified Auth receipt", async () => {
    const state = await fixture();
    try {
        await state.seed();
        const report: UpdateReport = {
            capturedAt: new Date().toISOString(),
            repositoryMetadataAt: null,
            complete: true,
            coveredKinds: ["os"],
            items: [],
        };
        await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('updates:edge',${JSON.stringify(report)}::text::jsonb,now())`;
        const osOnly = await state.read();
        expect(osOnly.map((item) => item.version)).toEqual(["1.2.3"]);
        report.coveredKinds = ["container"];
        report.complete = false;
        await state.client`UPDATE operation_snapshots SET value=${JSON.stringify(report)}::text::jsonb WHERE key='updates:edge'`;
        const incomplete = await state.read();
        expect(incomplete.map((item) => item.version)).toEqual(["1.2.3"]);
        report.complete = true;
        await state.client`UPDATE operation_snapshots SET value=${JSON.stringify(report)}::text::jsonb WHERE key='updates:edge'`;
        expect(await state.read()).toEqual([]);
    } finally {
        await state.close();
    }
});

test("shared Auth hosts use receipt time regardless of target order and replaced container IDs", async () => {
    const state = await fixture();
    try {
        const other = { ...target, id: "other-main" };
        await state.seed(target, "1.2.4", state.observedAt + 10);
        await state.seed(other, "1.2.3", state.observedAt);
        for (const targets of [
            [target, other],
            [other, target],
        ]) {
            const items = await state.read(targets);
            expect(items.map((item) => item.version)).toEqual(["1.2.4"]);
            expect(Object.keys(items[0]!)).not.toContain("service");
        }
    } finally {
        await state.close();
    }
});
