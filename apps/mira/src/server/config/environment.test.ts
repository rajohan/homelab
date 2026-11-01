import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { localCodeEnvironment } from "../sandbox/localBinding";
import { browserHostEnvironment } from "./environment";

const environment = {
    HOMELAB_MIRA_BROWSER_CONFIG: path.resolve("fixture/browser.json"),
    HOMELAB_DASHBOARD_DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
    HOMELAB_MIRA_FILES_DIR: path.resolve("fixture/files"),
};

test("browser host requires explicit absolute attachment storage before starting", () => {
    expect(browserHostEnvironment(environment)).toEqual({
        file: environment.HOMELAB_MIRA_BROWSER_CONFIG,
        databaseUrl: environment.HOMELAB_DASHBOARD_DATABASE_URL,
        port: 3441,
        filesDirectory: environment.HOMELAB_MIRA_FILES_DIR,
        localCode: undefined,
    });
    for (const filesDirectory of [undefined, "", "relative/files"])
        expect(() =>
            browserHostEnvironment({
                ...environment,
                HOMELAB_MIRA_FILES_DIR: filesDirectory,
            })
        ).toThrow("attachment storage requires an absolute path");
});

test("browser host rejects invalid service settings before advertising readiness", () => {
    for (const overrides of [
        { HOMELAB_MIRA_BROWSER_CONFIG: undefined },
        { HOMELAB_MIRA_BROWSER_CONFIG: "relative.json" },
        { HOMELAB_DASHBOARD_DATABASE_URL: undefined },
        { HOMELAB_DASHBOARD_DATABASE_URL: "https://localhost/fixture" },
        { HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/" },
        { HOMELAB_MIRA_BROWSER_HEALTH_PORT: "NaN" },
        { HOMELAB_MIRA_BROWSER_HEALTH_PORT: "0" },
        { HOMELAB_MIRA_BROWSER_HEALTH_PORT: "65536" },
    ])
        expect(() => browserHostEnvironment({ ...environment, ...overrides })).toThrow();
    expect(
        browserHostEnvironment({
            ...environment,
            HOMELAB_MIRA_BROWSER_HEALTH_PORT: "3442",
        }).port
    ).toBe(3442);
});

test("local target configuration accepts only nonsecret immutable deployment identities", () => {
    const binding = {
        kind: "main" as const,
        owner: "operator",
        hostId: "11111111-1111-4111-8111-111111111111",
        imageId: `sha256:${"a".repeat(64)}`,
        egress: {
            networkId: "b".repeat(64),
            proxyId: "c".repeat(64),
            proxyImageId: `sha256:${"d".repeat(64)}`,
        },
    };
    expect(localCodeEnvironment({})).toBeUndefined();
    const directory = mkdtempSync(path.join(tmpdir(), "local-binding-"));
    const file = path.join(directory, "code.json");
    try {
        writeFileSync(file, JSON.stringify(binding));
        expect(localCodeEnvironment({ HOMELAB_MIRA_LOCAL_CODE_FILE: file })).toEqual(
            binding
        );
        expect(() =>
            localCodeEnvironment({
                HOMELAB_MIRA_LOCAL_CODE_FILE: file,
                HOMELAB_MIRA_LOCAL_CODE: JSON.stringify(binding),
            })
        ).toThrow("one explicit");
        expect(() =>
            localCodeEnvironment({ HOMELAB_MIRA_LOCAL_CODE_FILE: "relative.json" })
        ).toThrow("one explicit");
        writeFileSync(file, "invalid");
        expect(() =>
            localCodeEnvironment({ HOMELAB_MIRA_LOCAL_CODE_FILE: file })
        ).toThrow();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
    expect(
        browserHostEnvironment({
            ...environment,
            HOMELAB_MIRA_LOCAL_CODE: JSON.stringify(binding),
        }).localCode
    ).toEqual(binding);
    for (const changed of [
        { ...binding, imageId: "latest" },
        { ...binding, socketPath: "/var/run/docker.sock" },
        { ...binding, apiKey: "synthetic" },
        { ...binding, egress: undefined },
    ]) {
        expect(() =>
            localCodeEnvironment({ HOMELAB_MIRA_LOCAL_CODE: JSON.stringify(changed) })
        ).toThrow();
    }
});
