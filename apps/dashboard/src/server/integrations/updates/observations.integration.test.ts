import { expect, test } from "bun:test";

import type {
    ApplicationInventory,
    ManagedApplication,
} from "@homelab/contracts/applications";
import type { UpdateReport } from "@homelab/contracts/updates";

import { createAutomation } from "../../automation/service";
import { startDashboardServer } from "../../index";
import { lockQueue } from "../../jobs/queue";
import { createApplicationFixture } from "../../testing/applications";
import { operationFixture } from "../../testing/operations";
import { bindApplicationHosts } from "../applications/configuration";
import { createDockerPort } from "../applications/docker";
import { collectApplications } from "../applications/inventory";
import { parseUpdateTargets } from "./configuration";
import { refreshDockerObservations } from "./observations";
import { updateControl } from "./selection";

test.each([
    "refresh",
    "unavailable",
    "unbound",
    "wrong-project",
    "reused-project-name",
    "wrong-service",
    "missing-watermark",
    "equal-publication",
    "source-owner-demo",
    "source-owner-other",
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
            const conflictingOwners = scenario.startsWith("source-owner-");
            if (conflictingOwners) {
                const original = targets[0]!;
                if (original.driver.kind !== "docker")
                    throw new Error("Missing Docker fixture");
                targets.push({
                    ...original,
                    id: "other-web",
                    source: "alias",
                    driver: { ...original.driver, project: "other" },
                });
            }
            const bindings = bindApplicationHosts(
                [
                    {
                        id: "main",
                        label: "Main",
                        endpoint: "http://fixture.invalid:2375",
                        projects:
                            scenario === "reused-project-name" || conflictingOwners
                                ? ["demo", "other"]
                                : ["demo"],
                        updateSources: ["software", "alias", "read-only"],
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
                name: scenario === "wrong-service" ? "another-service" : "web",
                containerName: "demo-web-1",
                project: [
                    "wrong-project",
                    "reused-project-name",
                    "source-owner-other",
                ].includes(scenario)
                    ? "other"
                    : "demo",
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
            // Seed publications before the host starts its remote observation.
            for (const key of [
                "updates:software",
                "updates.resolved:software",
                "updates:alias",
                "updates.resolved:alias",
                "updates:read-only",
                "updates.resolved:read-only",
                "updates:unrelated",
            ])
                await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(${key},${JSON.stringify(report)}::text::jsonb,${capturedAt}::timestamptz)`;
            await Bun.sleep(3);
            let observationStartedAt = new Date().toISOString();
            if (scenario === "equal-publication") observationStartedAt = capturedAt;
            if (scenario === "newer-publication")
                observationStartedAt = new Date(Date.now() - 120_000).toISOString();
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
                        ...(scenario === "missing-watermark"
                            ? {}
                            : { observationStartedAt }),
                        applications: [app],
                    },
                ],
            };
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
                const ownedSource =
                    scenario === "source-owner-demo" ? "software" : "alias";
                const refreshed = conflictingOwners
                    ? row.key.endsWith(":" + ownedSource)
                    : ["refresh", "overlay"].includes(scenario) &&
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

test.each(
    [
        { changedImage: false, delayedPublication: false },
        { changedImage: true, delayedPublication: false },
        { changedImage: false, delayedPublication: true },
        { changedImage: true, delayedPublication: true },
    ].flatMap((scenario) => [false, true].map((existing) => ({ ...scenario, existing })))
)(
    "software publication during Docker reads is preserved: %j",
    async ({ changedImage, delayedPublication, existing }) => {
        const state = await operationFixture();
        const fixture = createApplicationFixture();
        const publisher = await createAutomation(state.client, "human:test", {
            label: "Publisher",
            capabilities: ["updates:publish"],
            expiresAt: null,
        });
        const server = startDashboardServer({
            hostname: "127.0.0.1",
            port: 0,
            development: false,
            authentication: null,
            operations: {
                databaseUrl: state.url,
                metricsUrl: undefined,
                metricsToken: undefined,
                concurrency: 1,
                retentionDays: 30,
                updateSources: [
                    { id: "software", label: "Software", publisher: publisher.id },
                ],
            },
        });
        const publish = async (value: UpdateReport) => {
            const response = await fetch(
                new URL("/api/automation/updates.publish", server.url),
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${publisher.token}`,
                    },
                    body: JSON.stringify({ json: value }),
                }
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                result: { data: { json: { accepted: true } } },
            });
        };
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
                            name: "demo-web",
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
                [{ ...fixture.target, updateSources: ["software"] }],
                targets
            );
            const port = createDockerPort(fixture.target, {});
            let published: UpdateReport | undefined;
            const oldTime = new Date(Date.now() - 60_000).toISOString();
            if (existing) {
                const previous: UpdateReport = {
                    capturedAt: new Date(Date.now() - 120_000).toISOString(),
                    repositoryMetadataAt: null,
                    complete: true,
                    coveredKinds: ["container"],
                    items: [],
                };
                await publish(previous);
                await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES('updates.resolved:software',${JSON.stringify(previous)}::text::jsonb,${previous.capturedAt}::timestamptz)`;
            }
            const inventory = await collectApplications(
                bindings,
                () => ({
                    ...port,
                    async inspect(id, signal) {
                        const stale = await port.inspect(id, signal);
                        if (stale.Name === "/demo-web") {
                            // The Docker response has already been read. Publish a newer
                            // container identity on a real independent PostgreSQL transaction.
                            await Bun.sleep(3);
                            published = {
                                capturedAt: delayedPublication
                                    ? oldTime
                                    : new Date().toISOString(),
                                repositoryMetadataAt: null,
                                complete: true,
                                coveredKinds: ["container"],
                                items: [
                                    {
                                        id: `docker:${"e".repeat(64)}`,
                                        name: "demo-web",
                                        kind: "container",
                                        installed: changedImage
                                            ? "sha256:" + "f".repeat(64)
                                            : stale.Image,
                                        image: changedImage
                                            ? "example/web:2.0.0"
                                            : stale.Config.Image,
                                        available: "sha256:" + "d".repeat(64),
                                        status: "available",
                                        security: false,
                                        held: false,
                                    },
                                ],
                            };
                            // Exercise the actual authenticated HTTP publisher, including
                            // its source-supplied captured_at on INSERT and ON CONFLICT.
                            await publish(published);
                            const verified = {
                                ...published,
                                items: published.items.map((item) => ({
                                    ...item,
                                    candidateVerified: true,
                                })),
                            };
                            // The DB mutation fence also covers independent resolver/receipt
                            // writes even when their observation time remains old.
                            await state.client`INSERT INTO operation_snapshots(key,value,captured_at)
                                VALUES('updates.resolved:software',${JSON.stringify(verified)}::text::jsonb,${published.capturedAt}::timestamptz)
                                ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, captured_at=EXCLUDED.captured_at`;
                        }
                        return stale;
                    },
                }),
                AbortSignal.timeout(5000)
            );
            expect(published).toBeDefined();
            expect(inventory.hosts[0]?.observationStartedAt).toBeDefined();
            expect(Date.parse(inventory.hosts[0]!.observationStartedAt!)).toBeLessThan(
                Date.parse(inventory.capturedAt)
            );
            await state.client.begin(async (transaction) => {
                await lockQueue(transaction);
                await refreshDockerObservations(
                    transaction,
                    inventory,
                    bindings,
                    targets
                );
            });
            const rows = await state.client<
                {
                    key: string;
                    value: UpdateReport;
                    captured_at: Date;
                    mutated_at: Date;
                }[]
            >`
            SELECT key,value,captured_at,mutated_at FROM operation_snapshots WHERE key LIKE 'updates%'`;
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                expect(row.value).toEqual(
                    row.key.startsWith("updates.resolved:")
                        ? {
                              ...published!,
                              items: published!.items.map((item) => ({
                                  ...item,
                                  candidateVerified: true,
                              })),
                          }
                        : published!
                );
                expect(row.captured_at.toISOString()).toBe(published!.capturedAt);
                expect(row.mutated_at.getTime()).toBeGreaterThan(
                    Date.parse(inventory.hosts[0]!.observationStartedAt!)
                );
            }
            expect(fixture.calls).toEqual([]);
        } finally {
            await server.stop();
            await fixture.close();
            await state.close();
        }
    }
);
