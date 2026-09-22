import { expect, test } from "bun:test";

import type { ManagedApplication } from "@homelab/contracts/applications";
import type { UpdateReport } from "@homelab/contracts/updates";

import { applicationFixtureDetail } from "../../testing/applications";
import { mapDockerApplication } from "../applications/inventory";
import {
    hasApplicationCodeMount,
    reconcileDockerObservations as reconcile,
} from "./observations";

const app: ManagedApplication = {
    id: "main:" + "b".repeat(64),
    host: "main",
    containerId: "b".repeat(64),
    name: "web",
    containerName: "demo-web-1",
    project: "demo",
    image: "example/web:1",
    imageId: "sha256:" + "c".repeat(64),
    state: "running",
    health: "healthy",
    startedAt: new Date().toISOString(),
    revision: "d".repeat(64),
    ports: [],
    mounts: [],
    networks: [],
};
const report: UpdateReport = {
    capturedAt: new Date().toISOString(),
    repositoryMetadataAt: null,
    complete: true,
    coveredKinds: ["container"],
    items: [
        {
            id: "docker:" + "a".repeat(64),
            name: app.containerName,
            kind: "container",
            installed: app.imageId,
            image: app.image,
            available: "sha256:" + "d".repeat(64),
            status: "available",
            security: false,
            held: false,
            candidateVerified: true,
        },
    ],
};
const owner = { name: app.containerName, project: app.project, service: app.name };

function reconcileDockerObservations(
    value: UpdateReport,
    applications: readonly ManagedApplication[],
    owners: readonly (typeof owner)[] = [owner]
) {
    return reconcile(value, applications, owners);
}

test("same-image discovery refreshes the exact container identity without changing publication time or candidate", () => {
    const next = reconcileDockerObservations(report, [app]);
    expect(next).toEqual({
        ...report,
        items: [{ ...report.items[0]!, id: `docker:${app.containerId}` }],
    });
    expect(report.items[0]?.id).toBe("docker:" + "a".repeat(64));
});

test.each(["digest", "reference"])(
    "a changed image %s invalidates release verification",
    (field) => {
        const changed = {
            ...app,
            ...(field === "digest"
                ? { imageId: "sha256:" + "f".repeat(64) }
                : { image: "other/web:1" }),
        };
        const next = reconcileDockerObservations(report, [changed]).items[0]!;
        expect(next.candidateVerified).toBe(false);
        expect(next.available).toBeNull();
        expect(next.status).toBe("unknown");
        expect(next.installationBlock).toContain("installed image changed");
        expect(next.id).toBe(report.items[0]!.id);
    }
);

test("ambiguous names never rebind a software observation", () => {
    expect(
        reconcileDockerObservations(report, [
            app,
            { ...app, containerId: "e".repeat(64) },
        ])
    ).toEqual(report);
});

test.each([
    "/app/providers/sync/stremio/_history.py",
    "/app/lib/plugin.js",
    "/app/src",
    "/app/cw_platform/orchestrator",
    "/usr/local/lib/site-packages/module.py",
    "/app",
    "/opt/homelab/custom-entrypoint.py",
    "/opt/homelab/custom-worker.js",
    "/opt/homelab/logout-worker.js/extra.js",
    "/opt/homelab/../homelab/logout-worker.js",
    "/usr/local/bin/custom-entrypoint.sh",
    "/config/start.sh",
    "/config/start.BASH",
    "/custom/program.exe",
    "/usr/local/bin/extensionless",
    "/usr/libexec/worker",
    "/bin",
])("executable overlay %s blocks installation", (destination) => {
    const patched = {
        ...app,
        mounts: [
            { type: "bind", source: "/fixture/override", destination, readOnly: true },
        ],
    };
    expect(hasApplicationCodeMount(patched)).toBe(true);
    expect(
        reconcileDockerObservations(report, [patched]).items[0]?.installationBlock
    ).toContain("Local application code");
});

test.each(["/config", "/app/data", "/app/.env", "/etc/ssl/ca.pem", "/app/config.json"])(
    "ordinary configuration/data mount %s remains updateable",
    (destination) => {
        expect(
            hasApplicationCodeMount({
                ...app,
                mounts: [
                    {
                        type: "bind",
                        source: "/fixture/data",
                        destination,
                        readOnly: false,
                    },
                ],
            })
        ).toBe(false);
    }
);

test.each([
    {
        entrypoint: ["/custom/start"],
        command: [],
        directory: "/",
        destination: "/custom/start",
        blocked: true,
    },
    {
        entrypoint: ["/bin/sh", "/custom/start"],
        command: [],
        directory: "/",
        destination: "/custom",
        blocked: true,
    },
    {
        entrypoint: ["/bin/sh"],
        command: ["-c", "exec ./start --token=SYNTHETIC_PRIVATE"],
        directory: "/custom",
        destination: "/custom/start",
        blocked: true,
    },
    {
        entrypoint: null,
        command: ["/custom/start"],
        directory: "/",
        destination: "/custom/start",
        blocked: true,
    },
    {
        entrypoint: ["/vendor/app"],
        command: ["--config", "/config/app.json"],
        directory: "/",
        destination: "/config",
        blocked: false,
    },
])(
    "startup code metadata is bounded and private: %j",
    ({ entrypoint, command, directory, destination, blocked }) => {
        const detail = applicationFixtureDetail("a".repeat(64), "web");
        detail.Config.Entrypoint = entrypoint ? [...entrypoint] : null;
        detail.Config.Cmd = [...command];
        detail.Config.WorkingDir = directory;
        detail.Mounts = [
            { Type: "bind", Source: "/fixture", Destination: destination, RW: false },
        ];
        const mapped = mapDockerApplication(
            {
                id: "main",
                label: "Main",
                endpoint: "http://fixture.invalid:2375",
                projects: ["demo"],
            },
            detail
        );
        expect(hasApplicationCodeMount(mapped)).toBe(blocked);
        expect(JSON.stringify(mapped)).not.toContain("SYNTHETIC_PRIVATE");
        expect(mapped).not.toHaveProperty("Config");
    }
);

test("standalone logout helpers do not block an otherwise unmodified vendor image", () => {
    expect(
        hasApplicationCodeMount({
            ...app,
            mounts: [
                {
                    type: "bind",
                    source: "/fixture/logout-worker.js",
                    destination: "/opt/homelab/logout-worker.js",
                    readOnly: true,
                },
            ],
        })
    ).toBe(false);
});

test("removing an overlay clears only its installation block on the next observation", () => {
    const blocked = {
        ...report,
        items: [{ ...report.items[0]!, installationBlock: "Local application code" }],
    };
    expect(
        reconcileDockerObservations(blocked, [app]).items[0]?.installationBlock
    ).toBeUndefined();
});

test.each(["project", "service"])(
    "a reused container name with another Compose %s is not reconciled",
    (kind) => {
        const changed = {
            ...app,
            ...(kind === "project" ? { project: "other" } : { name: "other" }),
        };
        expect(reconcileDockerObservations(report, [changed])).toEqual(report);
    }
);

test("missing or ambiguous configured owners cannot rebind identities", () => {
    expect(reconcileDockerObservations(report, [app], [])).toEqual(report);
    expect(
        reconcileDockerObservations(
            report,
            [app],
            [owner, { ...owner, project: "other" }]
        )
    ).toEqual(report);
    expect(
        reconcileDockerObservations(report, [app], [owner, { ...owner }]).items[0]?.id
    ).toBe(`docker:${app.containerId}`);
});
