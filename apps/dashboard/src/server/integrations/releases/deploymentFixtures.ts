import { parseUpdateTargets } from "../updates/configuration";
import type { ReleaseDeploymentTarget } from "./deploymentConfiguration";
import { releaseDeploymentRevision } from "./deploymentConfiguration";
import { deploymentDigest, type DeploymentPlan } from "./deploymentProtocol";

/** Synthetic, non-routable deployment authority shared by isolated tests. */
export const deploymentTestConnections = parseUpdateTargets(
    JSON.stringify([
        {
            id: "demo",
            label: "Demo",
            source: "demo",
            host: "host.example.test",
            user: "operator",
            identityFile: "/run/secret/key",
            knownHostsFile: "/run/secret/hosts",
            driver: { kind: "apt" },
        },
    ])
);
export const deploymentTestTarget: ReleaseDeploymentTarget = {
    id: "main",
    label: "Dashboard and Mira",
    connection: "demo",
    project: "homelab",
    directory: "/srv/homelab",
    composeFile: "/srv/homelab/compose.yaml",
    stateDirectory: "/var/lib/homelab-releases",
    composeCommand: ["/usr/bin/docker", "compose", "-f", "/srv/homelab/compose.yaml"],
    backupCommand: ["/usr/bin/python3", "{runner}", "backup"],
    migrateCommand: [
        "/usr/bin/docker",
        "run",
        "--rm",
        "{image}",
        "migrate.js",
        "--apply",
    ],
    mira: true,
    services: [
        { name: "dashboard", app: "dashboard" },
        { name: "worker", app: "dashboard" },
        { name: "mira", app: "mira" },
    ],
    units: ["homelab.service"],
};
/**
 * Build independent release evidence without real hosts or production identities.
 * @param target - Optional modified synthetic deployment recipe.
 * @param connections - Synthetic SSH authorities, including Auth when configured.
 * @returns A plan matching the same hashing and protocol used by the real host boundary.
 */
export function deploymentTestPlan(
    target = deploymentTestTarget,
    connections = deploymentTestConnections
): DeploymentPlan {
    return {
        configuration: releaseDeploymentRevision(target, connections),
        ...(target.auth
            ? { authExpected: deploymentTestPlan(target.auth, connections).expected }
            : {}),
        release: {
            repository: "demo/homelab",
            version: "1.2.3",
            revision: "b".repeat(40),
            images: (["auth", "dashboard", "mira"] as const).map((app) => ({
                app,
                reference: `ghcr.io/demo/homelab/${app}:1.2.3@sha256:${"c".repeat(64)}`,
            })),
        },
        expected: {
            targetHash: deploymentDigest(target),
            composeHash: "d".repeat(64),
            configHash: "e".repeat(64),
            browserHash: null,
            containers: Object.fromEntries(
                target.services.map((service) => [
                    service.name,
                    {
                        id: "a".repeat(64),
                        imageId: `sha256:${"a".repeat(64)}`,
                        image: `ghcr.io/demo/homelab/${service.app}:1.2.2@sha256:${"a".repeat(64)}`,
                        running: true,
                        health: "healthy" as const,
                    },
                ])
            ),
            units: Object.fromEntries(
                target.units.map((unit) => [
                    unit,
                    { active: "active" as const, invocation: "a".repeat(32) },
                ])
            ),
        },
    };
}
