import { expect, test } from "bun:test";

import { parseOperationsConfiguration } from "./operations";

test("snapshot catalogs require encrypted scoped audit access and reject duplicate or traversing namespaces", () => {
    const base = {
        HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/dashboard",
        HOMELAB_DASHBOARD_PBS_URL: "https://pbs.example.test",
        HOMELAB_DASHBOARD_PBS_TOKEN: "demo@pbs!audit=synthetic-only",
        HOMELAB_DASHBOARD_PBS_STORES: '[{"datastore":"backups"}]',
        HOMELAB_DASHBOARD_RULES_URL: "https://monitor.example.test/rules",
    };
    expect(parseOperationsConfiguration(base)?.backupCatalog?.stores).toEqual([
        { datastore: "backups", namespace: "" },
    ]);
    for (const override of [
        { HOMELAB_DASHBOARD_PBS_URL: "http://pbs.example.test" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "invalid" },
        { HOMELAB_DASHBOARD_PBS_STORES: "[]" },
        {
            HOMELAB_DASHBOARD_PBS_STORES:
                '[{"datastore":"backups","namespace":"../private"}]',
        },
        {
            HOMELAB_DASHBOARD_PBS_STORES:
                '[{"datastore":"backups"},{"datastore":"backups","namespace":""}]',
        },
        { HOMELAB_DASHBOARD_RULES_URL: "https://user:pass@monitor.example.test" },
        { HOMELAB_DASHBOARD_RULES_URL: "https://monitor.example.test?token=private" },
    ])
        expect(() => parseOperationsConfiguration({ ...base, ...override })).toThrow();
    expect(
        parseOperationsConfiguration({
            ...base,
            NODE_ENV: "development",
            HOMELAB_DASHBOARD_PBS_URL: "http://127.0.0.1:9999",
        })?.backupCatalog
    ).toBeDefined();
});

test("operations are explicit, bounded and independent from identity configuration", () => {
    expect(parseOperationsConfiguration({})).toBeUndefined();
    const input = { HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/dashboard" };
    expect(parseOperationsConfiguration(input)?.concurrency).toBe(3);
    expect(() =>
        parseOperationsConfiguration({
            ...input,
            HOMELAB_DASHBOARD_WORKER_CONCURRENCY: "0",
        })
    ).toThrow();
    expect(() =>
        parseOperationsConfiguration({
            ...input,
            HOMELAB_DASHBOARD_METRICS_URL: "https://user:password@example.test",
        })
    ).toThrow();
    expect(() =>
        parseOperationsConfiguration({
            ...input,
            HOMELAB_DASHBOARD_DATABASE_URL: "sqlite://test",
        })
    ).toThrow();
});

test("monitoring endpoints and source publishers are explicitly scoped", () => {
    const base = { HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/dashboard" };
    const source = { id: "example", label: "Example", publisher: crypto.randomUUID() };
    const configured = parseOperationsConfiguration({
        ...base,
        HOMELAB_DASHBOARD_ALERTMANAGER_URL: "https://monitor.example.test/alerts",
        HOMELAB_DASHBOARD_UPDATE_SOURCES: JSON.stringify([source]),
    });
    expect(configured?.alerts?.excludedNames).toEqual(["Watchdog"]);
    expect(configured?.updateSources).toEqual([source]);
    for (const url of [
        "file:///etc/private",
        "https://user:pass@example.test",
        "https://example.test?token=private",
    ]) {
        expect(() =>
            parseOperationsConfiguration({
                ...base,
                HOMELAB_DASHBOARD_ALERTMANAGER_URL: url,
            })
        ).toThrow();
    }
    for (const entries of [
        [source, source],
        [source, { ...source, id: "another" }],
        [{ ...source, publisher: "operator" }],
    ]) {
        expect(() =>
            parseOperationsConfiguration({
                ...base,
                HOMELAB_DASHBOARD_UPDATE_SOURCES: JSON.stringify(entries),
            })
        ).toThrow();
    }
});
