import { expect, test } from "bun:test";

import { parseUpdateTargets } from "../updates/configuration";
import { parseMaintenanceTargets } from "./configuration";
import { maintenanceHosts } from "./hosts";

test("host groups share canonical authority across connection aliases without revealing SSH details", () => {
    const connection = {
        id: "primary",
        label: "Private SSH label",
        source: "server-a",
        host: "Host.example.test",
        user: "operator",
        identityFile: "/run/secret/key",
        knownHostsFile: "/run/secret/hosts",
        driver: { kind: "apt" },
    };
    const connections = parseUpdateTargets(
        JSON.stringify([
            connection,
            {
                ...connection,
                id: "alias",
                source: "alias-source",
                host: "host.example.test",
            },
            {
                ...connection,
                id: "other",
                source: "server-b",
                host: "other.example.test",
            },
        ])
    );
    const target = {
        id: "service",
        connection: "primary",
        label: "Web",
        impact: "Temporary interruption",
        kind: "service",
        service: "web.service",
        health: ["/usr/bin/true"],
        workerIndependent: true,
    };
    const targets = parseMaintenanceTargets(
        JSON.stringify([
            target,
            { ...target, id: "alias", connection: "alias" },
            {
                ...target,
                id: "host",
                kind: "host",
                service: undefined,
                label: "Friendly host",
            },
            { ...target, id: "other", connection: "other" },
        ]),
        connections
    );
    const groups = maintenanceHosts(targets, connections);
    expect(groups.get("service")).toEqual(groups.get("alias"));
    expect(groups.get("host")).toEqual(groups.get("service"));
    expect(groups.get("host")?.label).toBe("Friendly host");
    expect(groups.get("other")?.label).toBe("server-b");
    expect(groups.get("other")?.id).not.toBe(groups.get("host")?.id);
    const reversed = maintenanceHosts(targets.toReversed(), connections.toReversed());
    for (const [id, group] of groups) expect(reversed.get(id)).toEqual(group);
    const publicText = JSON.stringify([...groups.values()]);
    for (const privateValue of [
        "example.test",
        "operator",
        "/run/secret",
        "Private SSH label",
    ])
        expect(publicText).not.toContain(privateValue);
});
