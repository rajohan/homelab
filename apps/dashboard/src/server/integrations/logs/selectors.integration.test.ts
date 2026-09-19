import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../../api/router";
import {
    applicationFixtureDetail,
    createApplicationFixture,
} from "../../testing/applications";
import { operationFixture, expectOperationFailure } from "../../testing/operations";
import { mapDockerApplication } from "../applications/inventory";

test("service log selectors include existing history and reject ambiguous cross-project names", async () => {
    const fixture = await operationFixture();
    const provider = createApplicationFixture();
    const target = {
        ...provider.target,
        projects: ["demo", "other"],
        logs: {
            labels: { host: "demo" },
            serviceLabel: "service",
            servicePrefix: "demo-",
            serviceValue: "service" as const,
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
        await save(true);
        await expectOperationFailure(
            caller.applications.logs({
                host: target.id,
                container: application.containerId,
                range: "1h",
            }),
            "multiple projects"
        );
    } finally {
        await provider.close();
        await fixture.close();
    }
});
