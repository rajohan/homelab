import { expect, test } from "bun:test";

import type { ManagedApplication } from "@homelab/contracts/applications";
import type { UpdateReport } from "@homelab/contracts/updates";

import { hasApplicationCodeMount, reconcileDockerObservations } from "./observations";

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
