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
import {
    collectApplications,
    readApplicationObservationTime,
} from "../applications/inventory";
import { parseUpdateTargets } from "./configuration";
import { refreshDockerObservations } from "./observations";
import { updateControl } from "./selection";

test.each([
    "Publisher reports an incompatible container configuration.",
    "Local application code is mounted over this image. Review or remove the override before updating.",
])(
    "authenticated publisher blocks survive discovery and overlay removal: %s",
    async (installationBlock) => {
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
            const observed = await collectApplications(
                bindings,
                () => port,
                AbortSignal.timeout(5000)
            );
            const app = observed.hosts[0]!.applications.find(
                (value) => value.containerName === "demo-web"
            )!;
            const capturedAt = new Date(Date.now() - 60_000).toISOString();
            const report: UpdateReport = {
                capturedAt,
                repositoryMetadataAt: null,
                complete: true,
                coveredKinds: ["container"],
                items: [
                    {
                        id: "docker:" + "e".repeat(64),
                        name: "demo-web",
                        kind: "container",
                        image: app.image,
                        installed: app.imageId,
                        available: "sha256:" + "f".repeat(64),
                        status: "available",
                        security: false,
                        held: false,
                        installationBlock,
                    },
                ],
            };
            const publish = (value: UpdateReport) =>
                fetch(new URL("/api/automation/updates.publish", server.url), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${publisher.token}`,
                    },
                    body: JSON.stringify({ json: value }),
                });
            const forged = await publish({
                ...report,
                items: [
                    {
                        ...report.items[0]!,
                        applicationBlock: "Forged dashboard provenance",
                    },
                ],
            });
            expect(forged.status).toBe(400);
            await forged.text();
            const accepted = await publish(report);
            expect(accepted.status).toBe(200);
            expect(await accepted.json()).toMatchObject({
                result: { data: { json: { accepted: true } } },
            });
            const verified = {
                ...report,
                items: report.items.map((item) => ({
                    ...item,
                    candidateVerified: true,
                    availableImage: "docker.io/example/web:2@sha256:" + "f".repeat(64),
                })),
            };
            await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES('updates.resolved:software',${JSON.stringify(verified)}::text::jsonb,${capturedAt}::timestamptz)`;
            let previousRevision: string | undefined;
            for (const overlay of [false, true, false]) {
                const watermark = await readApplicationObservationTime(state.client);
                const inventory: ApplicationInventory = {
                    ...observed,
                    hosts: observed.hosts.map((host) => ({
                        ...host,
                        observationStartedAt: watermark.time,
                        observationVisibility: watermark.visibility,
                        applications: host.applications.map((value) => ({
                            ...value,
                            mounts: overlay
                                ? [
                                      {
                                          type: "bind",
                                          source: "/fixture",
                                          destination: "/app/local.py",
                                          readOnly: true,
                                      },
                                  ]
                                : [],
                        })),
                    })),
                };
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
                    { key: string; value: UpdateReport }[]
                >`SELECT key,value FROM operation_snapshots WHERE key LIKE 'updates%' ORDER BY key`;
                expect(rows).toHaveLength(2);
                for (const row of rows) {
                    const item = row.value.items[0]!;
                    expect(item.id).toBe(`docker:${app.containerId}`);
                    expect(item.installationBlock).toBe(installationBlock);
                    expect(Boolean(item.applicationBlock)).toBe(overlay);
                    const control = updateControl(
                        targets[0]!,
                        { ...row.value, checkedAt: capturedAt },
                        item
                    );
                    expect(control.allowed).toBe(false);
                    expect(control.reason).toBe(installationBlock);
                    if (row.key === "updates.resolved:software") {
                        expect(item.candidateVerified).toBe(true);
                        if (previousRevision)
                            expect(control.revision).not.toBe(previousRevision);
                        previousRevision = control.revision;
                    }
                }
            }
            expect(fixture.calls).toEqual([]);
        } finally {
            await server.stop();
            await fixture.close();
            await state.close();
        }
    }
);

test.each(
    [false, true].flatMap((existing) =>
        ["before-read", "during-read", "during-reconcile"].map((commit) => ({
            existing,
            commit,
        }))
    )
)(
    "software mutation must be visible before observation starts: %j",
    async ({ existing, commit }) => {
        const state = await operationFixture();
        const fixture = createApplicationFixture();
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let publisher: Promise<unknown> | undefined;
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
            const ids = await port.list(AbortSignal.timeout(3000));
            const details = await Promise.all(
                ids.map((id) => port.inspect(id, AbortSignal.timeout(3000)))
            );
            const detail = details.find((row) => row.Name === "/demo-web")!;
            const capturedAt = new Date(Date.now() - 60_000).toISOString();
            const report: UpdateReport = {
                capturedAt,
                repositoryMetadataAt: null,
                complete: true,
                coveredKinds: ["container"],
                items: [
                    {
                        id: "docker:" + "e".repeat(64),
                        name: "demo-web",
                        kind: "container",
                        image: detail.Config.Image,
                        installed: detail.Image,
                        available: "sha256:" + "f".repeat(64),
                        candidateVerified: true,
                        status: "available",
                        security: false,
                        held: false,
                    },
                ],
            };
            if (existing)
                for (const key of ["updates:software", "updates.resolved:software"])
                    await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(${key},${JSON.stringify({ ...report, items: [] })}::text::jsonb,${capturedAt}::timestamptz)`;
            publisher = state.client.begin(async (transaction) => {
                // A savepoint gives writes a subtransaction, but the trigger must
                // retain the top-level xid used by pg_current_snapshot visibility.
                await transaction`SAVEPOINT publication`;
                for (const key of ["updates:software", "updates.resolved:software"])
                    await transaction`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(${key},${JSON.stringify(report)}::text::jsonb,${capturedAt}::timestamptz) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
                await transaction`RELEASE SAVEPOINT publication`;
                ready.resolve();
                await release.promise;
            });
            await Promise.race([
                ready.promise,
                publisher.then(() => {
                    throw new Error("Publisher ended before barrier");
                }),
            ]);
            if (commit === "before-read") {
                release.resolve();
                await publisher;
            }
            const inventory = await collectApplications(
                bindings,
                () => ({
                    ...port,
                    async inspect(id, signal) {
                        const result = await port.inspect(id, signal);
                        if (commit === "during-read") {
                            release.resolve();
                            await publisher;
                        }
                        return result;
                    },
                }),
                AbortSignal.timeout(5000),
                undefined,
                undefined,
                () => readApplicationObservationTime(state.client)
            );
            const refresh = state.client.begin(async (transaction) => {
                await lockQueue(transaction);
                await refreshDockerObservations(
                    transaction,
                    inventory,
                    bindings,
                    targets
                );
            });
            if (commit === "during-reconcile") {
                if (existing) {
                    let blocked = false;
                    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
                        const [row] = await state.client<
                            { blocked: boolean }[]
                        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%') AS blocked`;
                        blocked = row?.blocked ?? false;
                        if (!blocked) await Bun.sleep(5);
                    }
                    expect(blocked).toBe(true);
                } else await refresh;
                release.resolve();
            }
            await Promise.all([publisher, refresh]);
            const rows = await state.client<
                { value: UpdateReport; visible: boolean; older: boolean }[]
            >`SELECT value, pg_visible_in_snapshot(mutation_xid::xid8, ${inventory.hosts[0]!.observationVisibility}::pg_snapshot) AS visible, mutated_at < ${inventory.hosts[0]!.observationStartedAt}::timestamptz AS older FROM operation_snapshots WHERE key LIKE 'updates%'`;
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                expect(row.value).toEqual(
                    commit === "before-read"
                        ? {
                              ...report,
                              items: [{ ...report.items[0]!, id: "docker:" + detail.Id }],
                          }
                        : report
                );
                if (commit !== "before-read") {
                    expect(row.visible).toBe(false);
                    expect(row.older).toBe(true);
                }
            }
        } finally {
            release.resolve();
            await publisher?.catch(() => {});
            await fixture.close();
            await state.close();
        }
    }
);

test.each([-86_400_000, 86_400_000])(
    "worker discovery uses the database watermark despite clock skew %i",
    async (skew) => {
        const state = await operationFixture();
        const fixture = createApplicationFixture();
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
            // Isolate the altered JavaScript clock from the HTTP fixture, PostgreSQL
            // and other tests. Exercise the registered production discovery handler.
            const script = `
                import { SQL } from "bun";
                import { applicationJobs } from ${JSON.stringify(new URL("../applications/jobs.ts", import.meta.url).href)};
                import { createDockerPort } from ${JSON.stringify(new URL("../applications/docker.ts", import.meta.url).href)};
                import { lockQueue } from ${JSON.stringify(new URL("../../jobs/queue.ts", import.meta.url).href)};
                const input = JSON.parse(await Bun.stdin.text());
                const NativeDate = Date;
                globalThis.Date = class extends NativeDate {
                    constructor(value) { super(arguments.length ? value : NativeDate.now() + input.skew); }
                    static now() { return NativeDate.now() + input.skew; }
                };
                const client = new SQL(input.url);
                let published;
                try {
                    const handler = applicationJobs(input.bindings, client, target => {
                        const port = createDockerPort(target, {});
                        return {...port, async inspect(id, signal) {
                            const detail = await port.inspect(id, signal);
                            if (detail.Name === "/demo-web") {
                                await Bun.sleep(5);
                                const [{time}] = await client\`SELECT to_char(clock_timestamp() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time\`;
                                published = {capturedAt: time, repositoryMetadataAt: null, complete: true, coveredKinds: ["container"], items: [{id: "docker:" + "e".repeat(64), name: "demo-web", kind: "container", installed: detail.Image, image: detail.Config.Image, available: "sha256:" + "d".repeat(64), status: "available", security: false, held: false, candidateVerified: true}]};
                                for (const key of ["updates:software", "updates.resolved:software"])
                                    await client\`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(\${key},\${JSON.stringify(published)}::text::jsonb,\${time}::timestamptz)\`;
                            }
                            return detail;
                        }};
                    }, input.targets).find(job => job.definition.key === "applications.discover");
                    await handler.execute({}, {runId: "fixture", signal: AbortSignal.timeout(5000), reportProgress: async () => {}, commit: async write => {await client.begin(async tx => {await lockQueue(tx); await write(tx);}); return true;}});
                    const rows = await client\`SELECT key,value FROM operation_snapshots WHERE key IN ('applications.inventory','updates:software','updates.resolved:software')\`;
                    console.log(JSON.stringify({rows,published}));
                } finally { await client.close(); }
            `;
            const child = Bun.spawn([process.execPath, "--eval", script], {
                stdin: new Blob([
                    JSON.stringify({ url: state.url, bindings, targets, skew }),
                ]),
                stdout: "pipe",
                stderr: "pipe",
            });
            const [output, error, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect(error).toBe("");
            expect(code).toBe(0);
            const result = JSON.parse(output) as {
                rows: { key: string; value: ApplicationInventory | UpdateReport }[];
                published: UpdateReport;
            };
            const inventory = result.rows.find(
                (row) => row.key === "applications.inventory"
            )!.value as ApplicationInventory;
            const databaseClock = await readApplicationObservationTime(state.client);
            const databaseTime = Date.parse(databaseClock.time);
            expect(
                Math.abs(
                    Date.parse(inventory.hosts[0]!.observationStartedAt!) - databaseTime
                )
            ).toBeLessThan(5000);
            expect(
                Math.abs(Date.parse(inventory.capturedAt) - databaseTime - skew)
            ).toBeLessThan(5000);
            for (const row of result.rows.filter((row) => row.key.startsWith("updates")))
                expect(row.value).toEqual(result.published);
            expect(result.rows).toHaveLength(3);
            expect(fixture.calls).toEqual([]);
        } finally {
            await fixture.close();
            await state.close();
        }
    }
);

test.each(
    ["fresh", "stale", "unavailable", "missing", "no-clock", "empty"].flatMap(
        (firstState) =>
            [false, true].flatMap((reverse) =>
                [false, true].map((collision) => ({ firstState, reverse, collision }))
            )
    )
)(
    "shared-source host observations retain their original mutation fence: %j",
    async ({ reverse, firstState, collision }) => {
        const state = await operationFixture();
        try {
            const names = ["alpha", "bravo"];
            const capturedAt = new Date(Date.now() - 60_000).toISOString();
            const staleStart = new Date(Date.now() - 1000).toISOString();
            const digest = "sha256:" + "c".repeat(64);
            const targets = parseUpdateTargets(
                JSON.stringify(
                    (collision ? names.slice(0, 1) : names).map((name) => ({
                        id: name,
                        label: name,
                        source: "software",
                        host: `${name}.invalid`,
                        user: "updater",
                        identityFile: "/run/secrets/test-key",
                        knownHostsFile: "/run/secrets/test-hosts",
                        driver: {
                            kind: "docker",
                            name: `${name}-web`,
                            project: name,
                            service: "web",
                            directory: "/srv/demo",
                            file: "/srv/demo/compose.yaml",
                            imageFile: "/srv/demo/web.yaml",
                        },
                    }))
                )
            );
            const bindings = names.map((name) => ({
                id: name,
                label: name,
                endpoint: `http://${name}.invalid:2375`,
                projects: [collision ? "alpha" : name],
                updateSources: ["software"],
            }));
            const report: UpdateReport = {
                capturedAt,
                repositoryMetadataAt: null,
                complete: true,
                coveredKinds: ["container"],
                items: (collision ? names.slice(0, 1) : names).map((name, index) => ({
                    id: "docker:" + String(index + 1).repeat(64),
                    name: `${name}-web`,
                    kind: "container",
                    installed: digest,
                    image: "example/web:1",
                    available: "sha256:" + "d".repeat(64),
                    status: "available",
                    security: false,
                    held: false,
                    candidateVerified: true,
                })),
            };
            for (const key of ["updates:software", "updates.resolved:software"])
                await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(${key},${JSON.stringify(report)}::text::jsonb,${capturedAt}::timestamptz)`;
            await Bun.sleep(3);
            const { time: startedAt, visibility } = await readApplicationObservationTime(
                state.client
            );
            const hosts: ApplicationInventory["hosts"] = names.map((name, index) => ({
                id: name,
                label: name,
                available: !(firstState === "unavailable" && index === 0),
                observationStartedAt:
                    firstState === "stale" && index === 0 ? staleStart : startedAt,
                observationVisibility: visibility,
                applications: [
                    {
                        id: `${name}:` + String(index + 3).repeat(64),
                        host: name,
                        containerId: String(index + 3).repeat(64),
                        containerName: collision ? "alpha-web" : `${name}-web`,
                        name: "web",
                        project: collision ? "alpha" : name,
                        image: "example/web:1",
                        imageId: digest,
                        state: "running",
                        health: "healthy",
                        startedAt,
                        revision: "f".repeat(64),
                        ports: [],
                        mounts: [],
                        networks: [],
                    },
                ],
            }));
            if (["empty", "unavailable"].includes(firstState))
                hosts[0]!.applications = [];
            if (firstState === "no-clock") {
                delete hosts[0]!.observationStartedAt;
                delete hosts[0]!.observationVisibility;
            }
            const selectedHosts = firstState === "missing" ? hosts.slice(1) : hosts;
            await state.client.begin(async (transaction) => {
                await lockQueue(transaction);
                await refreshDockerObservations(
                    transaction,
                    {
                        capturedAt: startedAt,
                        hosts: reverse ? selectedHosts.toReversed() : selectedHosts,
                    },
                    bindings,
                    targets
                );
            });
            const rows = await state.client<
                { value: UpdateReport; captured_at: Date }[]
            >`SELECT value,captured_at FROM operation_snapshots WHERE key LIKE 'updates%'`;
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                expect(row.value.items.map((item) => item.id)).toEqual(
                    collision
                        ? ["docker:" + "1".repeat(64)]
                        : [
                              "docker:" + (firstState === "fresh" ? "3" : "1").repeat(64),
                              "docker:" + "4".repeat(64),
                          ]
                );
                if (collision) expect(row.value).toEqual(report);
                expect(row.value.items.every((item) => item.candidateVerified)).toBe(
                    true
                );
                expect(row.value.capturedAt).toBe(capturedAt);
                expect(row.captured_at.toISOString()).toBe(capturedAt);
            }
        } finally {
            await state.close();
        }
    }
);

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
            const watermark = await readApplicationObservationTime(state.client);
            let observationStartedAt = watermark.time;
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
                            : {
                                  observationStartedAt,
                                  observationVisibility: watermark.visibility,
                              }),
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
                AbortSignal.timeout(5000),
                undefined,
                undefined,
                () => readApplicationObservationTime(state.client)
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
