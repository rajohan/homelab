import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    loadUpdateTargets,
    updateTargetRevision,
} from "../integrations/updates/configuration";
import { parseOperationsConfiguration } from "./operations";

function withTargetFile(
    contents: string | Uint8Array,
    check: (file: string, directory: string) => void
) {
    const directory = mkdtempSync(path.join(tmpdir(), "homelab-target-config-"));
    const file = path.join(directory, "targets.json");
    try {
        writeFileSync(file, contents);
        check(file, directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

const exampleTarget = {
    id: "example-apt",
    label: "Example",
    source: "example",
    host: "host.example.test",
    user: "updater",
    identityFile: "/run/secrets/example",
    knownHostsFile: "/run/secrets/hosts",
    driver: { kind: "apt" },
};

test("packaged deployment targets validate without reading credentials or granting implicit access", () => {
    const targets = loadUpdateTargets(
        undefined,
        fileURLToPath(new URL("../../../config/update-targets.json", import.meta.url))
    );
    expect(targets).toHaveLength(70);
    expect(targets.filter((target) => target.driver.kind === "apt")).toHaveLength(11);
    expect(targets.filter((target) => target.driver.kind === "docker")).toHaveLength(19);
    expect(
        [
            ...new Set(
                targets
                    .filter((target) => target.driver.kind === "native")
                    .map(
                        (target) =>
                            target.driver.kind === "native" && target.driver.release
                    )
            ),
        ].toSorted((left, right) => String(left).localeCompare(String(right)))
    ).toEqual([
        "adguard-home",
        "adguardhome-sync",
        "alertmanager",
        "alloy",
        "blackbox-exporter",
        "bun",
        "codex",
        "github-cli",
        "loki",
        "nextcloud",
        "node",
        "node-exporter",
        "openclaw",
        "pve-exporter",
        "smartctl-exporter",
        "traefik",
        "victoriametrics",
    ]);
    const sources = [...new Set(targets.map((target) => target.source))];
    for (const source of sources) {
        const hostTargets = targets.filter((target) => target.source === source);
        expect(new Set(hostTargets.map((target) => target.host)).size).toBe(1);
        expect(new Set(hostTargets.map((target) => target.identityFile)).size).toBe(1);
    }
    const base = { HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/dashboard" };
    expect(parseOperationsConfiguration(base)?.updateTargets).toEqual([]);
    const selected = {
        ...base,
        HOMELAB_DASHBOARD_UPDATE_TARGETS_FILE: fileURLToPath(
            new URL("../../../config/update-targets.json", import.meta.url)
        ),
        HOMELAB_DASHBOARD_UPDATE_SOURCES: JSON.stringify(
            sources.map((id) => ({ id, label: id, publisher: crypto.randomUUID() }))
        ),
    };
    expect(parseOperationsConfiguration(selected)?.updateTargets).toEqual(targets);
});

test("file update targets preserve inline validation defaults and authority fingerprints", () => {
    const text = JSON.stringify([exampleTarget]);
    withTargetFile(text, (file) => {
        const inline = loadUpdateTargets(text, undefined);
        const loaded = loadUpdateTargets(undefined, file);
        expect(loaded).toEqual(inline);
        expect(loaded.map((target) => updateTargetRevision(target))).toEqual(
            inline.map((target) => updateTargetRevision(target))
        );
        const input = {
            HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/dashboard",
            HOMELAB_DASHBOARD_UPDATE_TARGETS_FILE: file,
            HOMELAB_DASHBOARD_UPDATE_SOURCES: JSON.stringify([
                { id: "example", label: "Example", publisher: crypto.randomUUID() },
            ]),
        };
        expect(parseOperationsConfiguration(input)?.updateTargets).toEqual(inline);
        expect(() =>
            parseOperationsConfiguration({
                ...input,
                HOMELAB_DASHBOARD_UPDATE_SOURCES: "[]",
            })
        ).toThrow();
    });
    expect(loadUpdateTargets(undefined, undefined)).toEqual([]);
});

test("file update targets reject ambiguous or inaccessible sources instead of falling back", () => {
    expect(() => loadUpdateTargets("[]", "/nonexistent/targets.json")).toThrow(
        "not both"
    );
    expect(() => loadUpdateTargets("", "/nonexistent/targets.json")).toThrow("not both");
    for (const path of [
        "targets.json",
        "",
        "/nonexistent/targets.json",
        "/invalid\0path",
    ])
        expect(() => loadUpdateTargets(undefined, path)).toThrow();
    withTargetFile("[]", (file, directory) => {
        const link = path.join(directory, "linked.json");
        symlinkSync(file, link);
        expect(() => loadUpdateTargets(undefined, link)).toThrow();
        expect(() => loadUpdateTargets(undefined, directory)).toThrow();
    });
});

test("file update targets bound UTF-8 input and retain strict schema validation", () => {
    withTargetFile(" ".repeat(1_048_574) + "[]", (file) => {
        expect(loadUpdateTargets(undefined, file)).toEqual([]);
    });
    for (const contents of [
        " ".repeat(1_048_575) + "[]",
        new Uint8Array([0xff]),
        "{",
        "[{}]",
        JSON.stringify([exampleTarget, exampleTarget]),
    ])
        withTargetFile(contents, (file) =>
            expect(() => loadUpdateTargets(undefined, file)).toThrow()
        );
});

test("snapshot catalogs require encrypted scoped audit access and reject duplicate or traversing namespaces", () => {
    const base = {
        HOMELAB_DASHBOARD_DATABASE_URL: "postgres://localhost/dashboard",
        HOMELAB_DASHBOARD_PBS_URL: "https://pbs.example.test",
        HOMELAB_DASHBOARD_PBS_TOKEN: "demo@pbs!audit:synthetic-only",
        HOMELAB_DASHBOARD_PBS_STORES: '[{"datastore":"backups"}]',
        HOMELAB_DASHBOARD_RULES_URL: "https://monitor.example.test/rules",
    };
    expect(parseOperationsConfiguration(base)?.backupCatalog?.stores).toEqual([
        { datastore: "backups", namespace: "" },
    ]);
    expect(parseOperationsConfiguration(base)?.backupCatalog?.token).toBe(
        "demo@pbs!audit:synthetic-only"
    );
    for (const override of [
        { HOMELAB_DASHBOARD_PBS_URL: "http://pbs.example.test" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "invalid" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "demo@pbs!audit=synthetic-only" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "demo@pbs!audit:" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "demo@pbs!:synthetic-only" },
        { HOMELAB_DASHBOARD_PBS_TOKEN: "demo@pbs!audit:synthetic\nonly" },
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
