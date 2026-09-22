import { expect, test } from "bun:test";

import type {
    ApplicationInventory,
    ManagedApplication,
} from "@homelab/contracts/applications";
import type { UpdateReport } from "@homelab/contracts/updates";

import { lockQueue } from "../../jobs/queue";
import { operationFixture } from "../../testing/operations";
import { bindApplicationHosts } from "../applications/configuration";
import { parseUpdateTargets } from "./configuration";
import { refreshDockerObservations } from "./observations";
import { updateControl } from "./selection";

test.each([
    "refresh",
    "unavailable",
    "unbound",
    "wrong-project",
    "newer-publication",
    "active-host",
    "overlay",
])(
    "discovery reconciles raw/resolved Docker observations with %s fences",
    async (scenario) => {
        const state = await operationFixture();
        try {
            const targets = parseUpdateTargets(
                JSON.stringify([
                    {
                        id: "web",
                        label: "Web",
                        source: "software",
                        host: "fixture.invalid",
                        user: "updater",
                        identityFile: "/run/secrets/test-key",
                        knownHostsFile: "/run/secrets/test-hosts",
                        driver: {
                            kind: "docker",
                            name: "demo-web-1",
                            project: "demo",
                            service: "web",
                            directory: "/srv/demo",
                            file: "/srv/demo/compose.yaml",
                            imageFile: "/srv/demo/web.yaml",
                        },
                    },
                ])
            );
            const bindings = bindApplicationHosts(
                [
                    {
                        id: "main",
                        label: "Main",
                        endpoint: "http://fixture.invalid:2375",
                        projects: ["demo"],
                        updateSources: ["software", "alias"],
                    },
                ],
                targets
            );
            const oldId = "a".repeat(64),
                newId = "b".repeat(64),
                digest = "sha256:" + "c".repeat(64);
            const capturedAt = new Date(Date.now() - 60_000).toISOString();
            const report: UpdateReport = {
                capturedAt,
                repositoryMetadataAt: null,
                complete: true,
                coveredKinds: ["container"],
                items: [
                    {
                        id: `docker:${oldId}`,
                        name: "demo-web-1",
                        kind: "container",
                        installed: digest,
                        image: "example/web:1",
                        available: "sha256:" + "d".repeat(64),
                        availableImage:
                            "docker.io/example/web:2@sha256:" + "e".repeat(64),
                        status: "available",
                        security: false,
                        held: false,
                        candidateVerified: true,
                    },
                ],
            };
            const app: ManagedApplication = {
                id: `main:${newId}`,
                host: "main",
                containerId: newId,
                name: "web",
                containerName: "demo-web-1",
                project: scenario === "wrong-project" ? "other" : "demo",
                image: "example/web:1",
                imageId: digest,
                state: "running",
                health: "healthy",
                startedAt: capturedAt,
                revision: "f".repeat(64),
                ports: [],
                networks: [],
                mounts:
                    scenario === "overlay"
                        ? [
                              {
                                  type: "bind",
                                  source: "/fixture/patch.py",
                                  destination: "/app/patch.py",
                                  readOnly: true,
                              },
                          ]
                        : [],
            };
            const inventory: ApplicationInventory = {
                capturedAt:
                    scenario === "newer-publication"
                        ? new Date(Date.now() - 120_000).toISOString()
                        : new Date().toISOString(),
                hosts: [
                    {
                        id: "main",
                        label: "Main",
                        available: scenario !== "unavailable",
                        applications: [app],
                    },
                ],
            };
            for (const key of [
                "updates:software",
                "updates.resolved:software",
                "updates:alias",
                "updates.resolved:alias",
                "updates:unrelated",
            ])
                await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(${key},${JSON.stringify(report)}::text::jsonb,${capturedAt}::timestamptz)`;
            if (scenario === "active-host") {
                const id = crypto.randomUUID(),
                    token = crypto.randomUUID();
                await state.client`INSERT INTO job_runs(id,action,label,resource_class,state,payload,fingerprint,idempotency_key,requested_by,attempt_limit,retry_safe,timeout_ms,resource_keys) VALUES(${id},'test','test','interactive','running','{}','fixture',${id},'test',1,false,60000,ARRAY[]::text[])`;
                const { applicationHostResourceKeys } =
                    await import("../applications/configuration");
                await state.client`INSERT INTO resource_leases(key,run_id,lease_token) VALUES(${applicationHostResourceKeys(bindings[0]!)[0]!},${id},${token})`;
            }
            await state.client.begin(async (transaction) => {
                await lockQueue(transaction);
                await refreshDockerObservations(
                    transaction,
                    inventory,
                    scenario === "unbound" ? [] : bindings,
                    targets
                );
            });
            const rows = await state.client<
                { key: string; value: UpdateReport; captured_at: Date }[]
            >`SELECT key,value,captured_at FROM operation_snapshots WHERE key LIKE 'updates%' ORDER BY key`;
            for (const row of rows) {
                const refreshed =
                    ["refresh", "overlay"].includes(scenario) &&
                    row.key !== "updates:unrelated";
                expect(row.value.items[0]?.id).toBe(
                    `docker:${refreshed ? newId : oldId}`
                );
                expect(row.captured_at.toISOString()).toBe(capturedAt);
                expect(row.value.capturedAt).toBe(capturedAt);
                if (refreshed) {
                    const before = updateControl(
                        targets[0]!,
                        { ...report, checkedAt: capturedAt },
                        report.items[0]!
                    );
                    const after = updateControl(
                        targets[0]!,
                        { ...row.value, checkedAt: capturedAt },
                        row.value.items[0]!
                    );
                    expect(after.revision).not.toBe(before.revision);
                    expect(after.allowed).toBe(scenario !== "overlay");
                }
            }
        } finally {
            await state.close();
        }
    }
);
