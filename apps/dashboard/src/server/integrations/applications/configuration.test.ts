import { expect, test } from "bun:test";

import { parseApplicationTargets } from "./configuration";

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
