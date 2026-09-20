import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../../api/router";
import {
    applicationFixtureDetail,
    createApplicationFixture,
} from "../../testing/applications";
import { operationFixture, expectOperationFailure } from "../../testing/operations";
import { mapDockerApplication } from "../applications/inventory";
import { readApplicationLogs } from "./transport";

test("legacy log reads preserve the fixed migration cutoff and merge chronology without opening new unlabeled streams", async () => {
    const cutoff = Date.now() - 60_000;
    const currentTime = String(BigInt(cutoff + 1000) * 1_000_000n);
    const legacyTime = String(BigInt(cutoff - 1000) * 1_000_000n);
    const requests: URL[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            const url = new URL(request.url);
            requests.push(url);
            const historical = url.searchParams.get("query")?.includes('container=""');
            return Response.json({
                status: "success",
                data: {
                    resultType: "streams",
                    result: [
                        {
                            stream: {
                                host: "demo",
                                container: historical ? "" : "demo-web-1",
                                service: "app-web",
                            },
                            values: [
                                [
                                    historical ? legacyTime : currentTime,
                                    historical ? "Old safe event" : "New safe event",
                                ],
                            ],
                        },
                    ],
                },
            });
        },
    });
    try {
        const data = await readApplicationLogs(
            { url: server.url.href, token: undefined },
            { host: "demo", container: "demo-web-1" },
            { range: "1h" },
            AbortSignal.timeout(2000),
            {
                until: new Date(cutoff).toISOString(),
                labels: { host: "demo", container: "", service: "app-web" },
            }
        );
        expect(data.entries.map((entry) => entry.message)).toEqual([
            "New safe event",
            "Old safe event",
        ]);
        expect(requests.map((url) => url.searchParams.get("query"))).toEqual([
            '{host="demo",container="demo-web-1"}',
            '{host="demo",container="",service="app-web"}',
        ]);
        expect(requests[1]?.searchParams.get("end")).toBe(
            String(BigInt(cutoff) * 1_000_000n)
        );
        expect(data.nextCursor).toBeNull();
    } finally {
        await server.stop(true);
    }
});

test("service log selectors include existing history and reject ambiguous cross-project names", async () => {
    const fixture = await operationFixture();
    const provider = createApplicationFixture();
    const target = {
        ...provider.target,
        projects: ["demo"],
        logs: {
            labels: { host: "demo" },
            serviceLabel: "service",
            servicePrefix: "demo-",
            serviceValue: "service" as const,
            projectLabel: undefined as string | undefined,
        },
    };
    const application = mapDockerApplication(
        target,
        applicationFixtureDetail("b".repeat(64), "web")
    );
    const operations = {
        ...fixture,
        applicationTargets: [target],
        logs: { url: provider.url, token: undefined },
    };
    const caller = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: "operator", capabilities },
    });
    try {
        const save = async (duplicate: boolean) => {
            const applications = duplicate
                ? [
                      application,
                      {
                          ...application,
                          id: "other",
                          containerId: "e".repeat(64),
                          project: "other",
                      },
                  ]
                : [application];
            const value = {
                capturedAt: new Date().toISOString(),
                hosts: [{ id: target.id, label: "Demo", available: true, applications }],
            };
            await fixture.client`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('applications.inventory', ${JSON.stringify(value)}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
        };
        await save(false);
        const data = await caller.applications.logs({
            host: target.id,
            container: application.containerId,
            range: "1h",
        });
        expect(data.entries.length).toBeGreaterThan(0);
        expect(provider.queries[0]).toBe('{host="demo",service="demo-web"}');
        target.projects.push("other");
        await expectOperationFailure(
            caller.applications.logs({
                host: target.id,
                container: application.containerId,
                range: "1h",
            }),
            "multiple projects"
        );
        expect(provider.queries).toHaveLength(1);
        await save(true);
        await expectOperationFailure(
            caller.applications.logs({
                host: target.id,
                container: application.containerId,
                range: "1h",
            }),
            "multiple projects"
        );
        await save(false);
        await expectOperationFailure(
            caller.applications.logs({
                host: target.id,
                container: application.containerId,
                range: "1h",
            }),
            "multiple projects"
        );
        target.logs.projectLabel = "project";
        await caller.applications.logs({
            host: target.id,
            container: application.containerId,
            range: "1h",
        });
        expect(provider.queries.at(-1)).toBe(
            '{host="demo",project="demo",service="demo-web"}'
        );
    } finally {
        await provider.close();
        await fixture.close();
    }
});
