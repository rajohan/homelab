import { expect, test } from "bun:test";

import { hostResourceKey } from "../../jobs/resources";
import { parseUpdateTargets } from "../updates/configuration";
import {
    parseApplicationTargets,
    bindApplicationHosts,
    applicationHostResourceKeys,
} from "./configuration";

const target = {
    id: "main",
    label: "Main",
    endpoint: "https://docker.example:2376",
    projects: ["demo"],
    tls: {
        ca: "HOMELAB_DASHBOARD_DOCKER_CA",
        certificate: "HOMELAB_DASHBOARD_DOCKER_CERT",
        key: "HOMELAB_DASHBOARD_DOCKER_KEY",
    },
};

test("Docker proxy and SSH addresses share physical host locks without broadening access", () => {
    const applications = parseApplicationTargets(JSON.stringify([target]));
    const [bound] = bindApplicationHosts(applications, [
        { source: "main", host: "192.0.2.10", driver: { kind: "docker" } },
        { source: "main", host: "192.0.2.10", driver: { kind: "apt" } },
        { source: "other", host: "192.0.2.20", driver: { kind: "apt" } },
    ]);
    expect(bound).toBeDefined();
    expect(applicationHostResourceKeys(bound!)).toContain(
        hostResourceKey("docker.example")
    );
    expect(applicationHostResourceKeys(bound!)).toContain(hostResourceKey("192.0.2.10"));
    expect(applicationHostResourceKeys(bound!)).toHaveLength(2);
    expect(bound!.projects).toEqual(target.projects);
    expect(bound!.endpoint).toBe(target.endpoint);
});

test("Docker updater source aliases require an explicit lifecycle host binding", () => {
    const applications = parseApplicationTargets(JSON.stringify([target]));
    const updates = [
        { source: "ssh-main", host: "192.0.2.10", driver: { kind: "docker" } },
    ];
    expect(() => bindApplicationHosts(applications, updates)).toThrow(
        "explicit application host binding"
    );
    expect(bindApplicationHosts([], updates)).toEqual([]);
    expect(bindApplicationHosts(applications, [])).toHaveLength(1);
    const [bound] = bindApplicationHosts(
        parseApplicationTargets(
            JSON.stringify([{ ...target, updateSources: ["main", "ssh-main"] }])
        ),
        updates
    );
    expect(applicationHostResourceKeys(bound!)).toContain(hostResourceKey("192.0.2.10"));
    expect(applicationHostResourceKeys(bound!)).toContain(
        hostResourceKey("docker.example")
    );
    expect(bound!.projects).toEqual(target.projects);
    for (const updateSources of [[], ["main", "main"], ["invalid source"]])
        expect(() =>
            parseApplicationTargets(JSON.stringify([{ ...target, updateSources }]))
        ).toThrow();
});

test("historical log mappings are explicit, bounded and cannot overlap other projects", () => {
    const legacy = {
        until: "2026-01-01T00:00:00Z",
        serviceLabel: "service",
        services: [{ project: "demo", service: "web", value: "app-web" }],
    };
    const logs = { labels: { host: "main" }, serviceLabel: "container", legacy };
    expect(
        parseApplicationTargets(JSON.stringify([{ ...target, logs }]))[0]?.logs?.legacy
    ).toEqual(legacy);
    for (const change of [
        { until: "2099-01-01T00:00:00Z" },
        { serviceLabel: "host" },
        { serviceLabel: "container" },
        { services: [{ project: "other", service: "web", value: "app-web" }] },
        { services: [...legacy.services, ...legacy.services] },
        {
            services: [
                ...legacy.services,
                { project: "demo", service: "other", value: "app-web" },
            ],
        },
    ])
        expect(() =>
            parseApplicationTargets(
                JSON.stringify([
                    { ...target, logs: { ...logs, legacy: { ...legacy, ...change } } },
                ])
            )
        ).toThrow();
});

test("lifecycle source bindings accept the full updater source range without enlarging host IDs", () => {
    for (const length of [32, 33, 48]) {
        const source = "a".repeat(length);
        const updates = parseUpdateTargets(
            JSON.stringify([
                {
                    id: "fixture",
                    label: "Fixture",
                    source,
                    host: "192.0.2.10",
                    user: "fixture",
                    identityFile: "/fixture/key",
                    knownHostsFile: "/fixture/hosts",
                    driver: { kind: "apt" },
                },
            ])
        );
        const applications = parseApplicationTargets(
            JSON.stringify([{ ...target, updateSources: [source] }])
        );
        expect(
            applicationHostResourceKeys(bindApplicationHosts(applications, updates)[0]!)
        ).toContain(hostResourceKey("192.0.2.10"));
    }
    for (const source of ["a".repeat(49), "invalid source", "UPPER", "-prefix"])
        expect(() =>
            parseApplicationTargets(
                JSON.stringify([{ ...target, updateSources: [source] }])
            )
        ).toThrow();
    expect(() =>
        parseApplicationTargets(JSON.stringify([{ ...target, id: "a".repeat(33) }]))
    ).toThrow();
});

test("application targets require explicit unique projects, secure origins and credential references", () => {
    expect(parseApplicationTargets(undefined)).toEqual([]);
    expect(parseApplicationTargets(JSON.stringify([target]))).toEqual([target]);
    for (const change of [
        { endpoint: "http://docker.example" },
        { endpoint: "https://user:pass@docker.example" },
        { endpoint: "https://docker.example/path" },
        { endpoint: "https://docker.example/?token=x" },
        { endpoint: "https://docker.example/#fragment" },
        { tls: undefined },
        { projects: [] },
        { projects: ["demo", "demo"] },
        {
            projects: ["demo", "other"],
            logs: {
                labels: { host: "main" },
                serviceLabel: "service",
                serviceValue: "service",
            },
        },
        { tls: { ...target.tls, key: "PRIVATE_KEY" } },
        { logs: { labels: { service: "other" }, serviceLabel: "service" } },
        {
            logs: {
                labels: { host: "main" },
                serviceLabel: "service",
                serviceValue: "command",
            },
        },
        {
            logs: {
                labels: { host: "main" },
                serviceLabel: "service",
                projectLabel: "host",
            },
        },
    ]) {
        expect(() =>
            parseApplicationTargets(JSON.stringify([{ ...target, ...change }]))
        ).toThrow();
    }
    expect(() => parseApplicationTargets(JSON.stringify([target, target]))).toThrow(
        "unique"
    );
    const local = { ...target, tls: undefined, endpoint: "http://127.0.0.1:1234" };
    expect(parseApplicationTargets(JSON.stringify([local]), true)).toHaveLength(1);
    expect(() => parseApplicationTargets(JSON.stringify([local]))).toThrow();
    expect(
        parseApplicationTargets(
            JSON.stringify([
                {
                    ...target,
                    logs: {
                        labels: { host: "main" },
                        serviceLabel: "service",
                        serviceValue: "service",
                        servicePrefix: "app-",
                        projectLabel: "project",
                    },
                },
            ])
        )[0]?.logs
    ).toMatchObject({ serviceValue: "service", projectLabel: "project" });
});
