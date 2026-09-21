import assert from "node:assert/strict";

import type { ApplicationOperation } from "@homelab/contracts/applications";

import { performApplicationAction } from "../integrations/applications/actions";
import { createDockerPort } from "../integrations/applications/docker";
import {
    collectApplications,
    mapDockerApplication,
} from "../integrations/applications/inventory";
import {
    selectApplications,
    selectionRevision,
} from "../integrations/applications/selection";

const owner = `homelab-docker-smoke-${crypto.randomUUID()}`;
const owned = new Set<string>();
const namespace = (id: string) => docker("exec", id, "readlink", "/proc/self/ns/net");

async function docker(...args: string[]): Promise<string> {
    const process = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(60_000),
    });
    const [output, error, status] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    assert.equal(status, 0, error);
    return output.trim();
}

async function create(
    service: string,
    network: string,
    health = "true",
    dependencies = "",
    namespaceKind: "network" | "ipc" = "network",
    project = owner
): Promise<string> {
    const id = await docker(
        "create",
        "--init",
        "--name",
        `${owner}-${service}`,
        "--label",
        `homelab.smoke=${owner}`,
        "--label",
        `com.docker.compose.project=${project}`,
        "--label",
        `com.docker.compose.service=${service}`,
        "--label",
        `com.docker.compose.depends_on=${dependencies}`,
        "--memory",
        "64m",
        "--pids-limit",
        "32",
        "--network",
        namespaceKind === "network" ? network : "none",
        "--ipc",
        namespaceKind === "ipc" ? network : "shareable",
        "--health-cmd",
        health,
        "--health-interval",
        "1s",
        "--health-retries",
        "1",
        "--entrypoint",
        "/bin/sleep",
        "postgres:18",
        "3600"
    );
    assert.match(id, /^[a-f0-9]{64}$/);
    owned.add(id);
    return id;
}

/**
 * Exercise the real Docker HTTP transport and lifecycle coordinator on owned disposable containers.
 * @returns Completion after actual stop/start/restart, namespace and failure assertions, followed by exact-owner cleanup.
 */
export async function main(): Promise<void> {
    const calls: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 45,
        async fetch(request) {
            const url = new URL(request.url);
            const match =
                /^\/v1\.47\/containers\/([a-f0-9]{64})\/(json|start|stop|restart)$/.exec(
                    url.pathname
                );
            let path = url.pathname + url.search;
            if (url.pathname === "/v1.47/containers/json" && request.method === "GET") {
                path =
                    "/v1.47/containers/json?" +
                    new URLSearchParams({
                        all: "true",
                        filters: JSON.stringify({ label: [`homelab.smoke=${owner}`] }),
                    }).toString();
            } else if (
                !match?.[1] ||
                !owned.has(match[1]) ||
                (match[2] === "json"
                    ? request.method !== "GET"
                    : request.method !== "POST")
            ) {
                return new Response(null, { status: 404 });
            }
            if (request.method === "POST") calls.push(`${match?.[2]}:${match?.[1]}`);
            return fetch(`http://localhost${path}`, {
                unix: "/var/run/docker.sock",
                method: request.method,
                signal: request.signal,
            });
        },
    });
    const target = {
        id: "smoke",
        label: "Disposable Docker",
        endpoint: `http://127.0.0.1:${server.port}`,
        projects: [owner],
    };
    const port = createDockerPort(target, {});
    const signal = AbortSignal.timeout(180_000);
    const intent = async (id: string, operation: ApplicationOperation) => {
        for (let attempt = 0; ; attempt += 1) {
            const ids = await port.list(signal);
            const details = await Promise.all(
                ids.map((identity) => port.inspect(identity, signal))
            );
            if (
                !details.some(
                    (detail) =>
                        detail.State.Status === "running" &&
                        detail.State.Health?.Status === "starting"
                )
            )
                break;
            assert.ok(
                attempt < 100,
                "Fixture health did not stabilize before confirmation"
            );
            await Bun.sleep(100);
        }
        const inventory = await collectApplications([target], () => port, signal);
        const selection = { kind: "container" as const, target: id };
        return {
            selection,
            revision: selectionRevision(
                selectApplications(inventory, target.id, selection, true),
                selection
            ),
            operation,
        };
    };
    const act = async (id: string, operation: ApplicationOperation) =>
        performApplicationAction(target, port, await intent(id, operation), signal);
    const state = async (id: string) => {
        const detail = await port.inspect(id, signal);
        return detail.State;
    };
    try {
        await docker("image", "inspect", "postgres:18");
        const provider = await create("provider", "none");
        await docker("start", provider);
        const consumer = await create("consumer", `container:${provider}`);
        const stopped = await create("stopped", `container:${provider}`);
        await docker("start", consumer);
        for (let attempt = 0; ; attempt += 1) {
            const observed = await state(provider);
            if (observed.Health?.Status === "healthy") break;
            assert.ok(attempt < 30, "Fixture provider failed to become healthy");
            await Bun.sleep(100);
        }
        // The coordinator waits for real Docker health rather than a fixture changing state.
        await act(consumer, "restart");
        assert.equal(await namespace(consumer), await namespace(provider));
        calls.length = 0;
        await act(provider, "restart");
        assert.deepEqual(calls, [
            `stop:${consumer}`,
            `stop:${provider}`,
            `start:${provider}`,
            `start:${consumer}`,
        ]);
        assert.equal(await namespace(consumer), await namespace(provider));
        let observed = await state(stopped);
        assert.equal(observed.Status, "created");
        await act(provider, "stop");
        observed = await state(consumer);
        assert.equal(observed.Status, "exited");
        await act(provider, "start");
        observed = await state(stopped);
        assert.equal(observed.Status, "running");
        assert.equal(await namespace(stopped), await namespace(provider));
        const stale = await intent(consumer, "restart");
        await docker("restart", "--time", "1", consumer);
        calls.length = 0;
        await assert.rejects(
            performApplicationAction(target, port, stale, signal),
            /changed/
        );
        assert.equal(calls.length, 0);
        const current = await intent(consumer, "stop");
        await assert.rejects(
            performApplicationAction(target, port, current, AbortSignal.abort())
        );
        assert.equal(calls.length, 0);
        await docker("pause", consumer);
        await act(consumer, "stop");
        observed = await state(consumer);
        assert.equal(observed.Status, "exited");
        await act(consumer, "start");
        const external = await create("external", "none");
        await docker("start", external);
        await docker("stop", "--time", "1", external);
        const externalConsumer = await create(
            "external-consumer",
            `container:${provider}`,
            "true",
            "external:service_healthy:false"
        );
        await docker("start", externalConsumer);
        const externalConsumerBefore = await state(externalConsumer);
        const providerBefore = await state(provider);
        calls.length = 0;
        await assert.rejects(act(provider, "restart"), /dependency/);
        assert.equal(
            calls.length,
            0,
            "Unready external dependencies must be checked before a coordinated stop"
        );
        const externalConsumerAfter = await state(externalConsumer);
        const providerAfter = await state(provider);
        assert.equal(externalConsumerAfter.StartedAt, externalConsumerBefore.StartedAt);
        assert.equal(providerAfter.StartedAt, providerBefore.StartedAt);
        await docker("start", external);
        await act(provider, "restart");
        assert.equal(await namespace(externalConsumer), await namespace(provider));
        assert.ok(
            !calls.some((call) => call.endsWith(`:${external}`)),
            "External dependencies must not be mutated"
        );
        const leaf = await create("leaf", `container:${consumer}`);
        await docker("start", leaf);
        for (let attempt = 0; ; attempt += 1) {
            const observedLeaf = await state(leaf);
            if (observedLeaf.Health?.Status === "healthy") break;
            assert.ok(attempt < 30, "Fixture leaf failed to become healthy");
            await Bun.sleep(100);
        }
        await docker("stop", "--time", "1", consumer);
        const leafBefore = await state(leaf);
        const rootBefore = await state(provider);
        calls.length = 0;
        await assert.rejects(act(provider, "restart"), /namespace/);
        assert.equal(
            calls.length,
            0,
            "A stopped intermediate provider must fail before stopping its running descendant"
        );
        const leafAfter = await state(leaf);
        const rootAfter = await state(provider);
        assert.deepEqual(
            [leafAfter.Status, leafAfter.StartedAt],
            [leafBefore.Status, leafBefore.StartedAt]
        );
        assert.deepEqual(
            [rootAfter.Status, rootAfter.StartedAt],
            [rootBefore.Status, rootBefore.StartedAt]
        );
        calls.length = 0;
        await assert.rejects(act(consumer, "start"), /stopped shared namespace provider/);
        assert.equal(calls.length, 0);
        await docker("stop", "--time", "1", leaf);
        await act(consumer, "start");
        const recoveredLeaf = await state(leaf);
        assert.equal(recoveredLeaf.Status, "running");
        assert.notEqual(recoveredLeaf.StartedAt, leafBefore.StartedAt);
        assert.equal(await namespace(leaf), await namespace(consumer));

        const ipcProvider = await create("ipc-provider", "none");
        await docker("start", ipcProvider);
        const ipcConsumer = await create(
            "ipc-consumer",
            `container:${ipcProvider}`,
            "true",
            "",
            "ipc"
        );
        await docker("start", ipcConsumer);
        await docker("stop", "--time", "1", ipcProvider);
        const ipcConsumerState = await state(ipcConsumer);
        assert.equal(ipcConsumerState.Status, "running");
        const ipcBefore = await docker(
            "exec",
            ipcConsumer,
            "readlink",
            "/proc/self/ns/ipc"
        );
        calls.length = 0;
        await assert.rejects(
            act(ipcProvider, "start"),
            /stopped shared namespace provider/
        );
        assert.equal(calls.length, 0);
        assert.equal(
            await docker("exec", ipcConsumer, "readlink", "/proc/self/ns/ipc"),
            ipcBefore
        );
        await docker("stop", "--time", "1", ipcConsumer);
        await act(ipcProvider, "start");
        assert.equal(
            await docker("exec", ipcConsumer, "readlink", "/proc/self/ns/ipc"),
            await docker("exec", ipcProvider, "readlink", "/proc/self/ns/ipc")
        );

        const projectSelection = { kind: "project" as const, target: owner };
        const projectIds = await port.list(signal);
        const projectRevision = selectionRevision(
            await Promise.all(
                projectIds.map(async (id) =>
                    mapDockerApplication(target, await port.inspect(id, signal))
                )
            ),
            projectSelection
        );
        const foreign = await create(
            "foreign",
            `container:${provider}`,
            "true",
            "",
            "network",
            `${owner}-other`
        );
        await docker("start", foreign);
        const extendedTarget = { ...target, projects: [owner, `${owner}-other`] };
        calls.length = 0;
        await assert.rejects(
            performApplicationAction(
                extendedTarget,
                createDockerPort(extendedTarget, {}),
                {
                    selection: projectSelection,
                    revision: projectRevision,
                    operation: "restart",
                },
                signal
            ),
            /project boundaries/
        );
        assert.equal(calls.length, 0);
        await docker("rm", "--force", "--volumes", foreign);
        const unhealthy = await create("unhealthy", "none", "false");
        calls.length = 0;
        await assert.rejects(act(unhealthy, "start"), /ready state/);
        assert.deepEqual(calls, [`start:${unhealthy}`]);
        const unhealthyState = await state(unhealthy);
        assert.equal(unhealthyState.Health?.Status, "unhealthy");
        observed = await state(consumer);
        const startedAt = observed.StartedAt;
        await docker("rm", "--force", "--volumes", provider);
        calls.length = 0;
        await assert.rejects(act(consumer, "restart"), /namespace/);
        assert.equal(
            calls.length,
            0,
            "A broken namespace must be rejected before stopping a still-running consumer"
        );
        observed = await state(consumer);
        assert.equal(observed.StartedAt, startedAt);
        process.stdout.write(
            "PASS: real Docker lifecycle, provider/dependent restart ordering, namespace identity, stopped-state preservation, unhealthy outcome, paused stop, stale consent, cancellation and no-stop preflight.\n"
        );
    } finally {
        await server.stop(true);
        for (const id of owned) {
            const process = Bun.spawn(
                [
                    "docker",
                    "inspect",
                    "--format",
                    '{{index .Config.Labels "homelab.smoke"}}',
                    id,
                ],
                { stdout: "pipe", stderr: "ignore" }
            );
            const labelOutput = await new Response(process.stdout).text();
            const label = labelOutput.trim();
            if ((await process.exited) === 0) {
                assert.equal(label, owner, "Cleanup cannot target another container");
                await docker("rm", "--force", "--volumes", id);
            }
        }
    }
}

if (import.meta.main) await main();
