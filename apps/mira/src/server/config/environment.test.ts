import { expect, test } from "bun:test";
import path from "node:path";

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
