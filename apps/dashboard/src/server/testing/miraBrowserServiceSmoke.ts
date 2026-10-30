import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { setMiraEnabled } from "@homelab/mira/data/automations";
import { requestMiraBrowserAccess } from "@homelab/mira/data/browserAccess";
import { createConversation, enqueueTurn } from "@homelab/mira/data/conversations";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { createTestDatabase } from "../../../../../tests/database";
import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import type { RuntimeToolResult } from "../../../../mira/src/server/runtime/toolResult";
import { connectDashboardDatabase } from "../database/connection";
import { migrateDashboard } from "../database/migrations";

/**
 * Qualify the built host CLI and model-tool queue against actual offline Chromium.
 * @returns A content-free receipt after trusted DOM input and complete service shutdown.
 */
export async function main() {
    const allocation = await createTestDatabase();
    const db = connectDashboardDatabase(allocation.url, 6);
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mira-browser-service-"));
    const execute = promisify(execFile);
    const socketPath = await realpath("/var/run/docker.sock");
    const docker = async (...args: string[]) => {
        const result = await execute(
            "/usr/bin/docker",
            ["--config", temporary, "--host", `unix://${socketPath}`, ...args],
            {
                env: { PATH: "/usr/bin:/bin", HOME: temporary },
                timeout: 10_000,
                maxBuffer: 65_536,
            }
        );
        return result.stdout.trim();
    };
    let host: ReturnType<typeof Bun.spawn> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("synthetic"),
    });
    const healthPort = reservation.port!;
    await reservation.stop(true);
    let selected: string | undefined;
    try {
        await migrateDashboard(db);
        const context = {
            client: db.client,
            owner: "synthetic-browser-operator",
            actor: "human:synthetic-browser-operator",
        };
        await setMiraEnabled(context, {
            key: "computer:browser",
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
        const conversation = await createConversation(
            context,
            "Synthetic native browser service"
        );
        await db.client.begin((query) =>
            enqueueTurn(query, context, {
                conversationId: conversation.id,
                requestId: crypto.randomUUID(),
                text: "Inspect the synthetic offline website.",
                attachmentIds: [],
            })
        );
        const run = await claimMiraRun(db.client, crypto.randomUUID(), "foreground");
        assert.ok(run);
        heartbeat = setInterval(() => {
            void db.client`UPDATE mira_runs SET lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=${run.id} AND state='running'`.catch(
                () => {}
            );
        }, 5000);
        await requestMiraBrowserAccess(context, {
            runId: run.id,
            origins: ["http://127.0.0.1:4173"],
            initialUrl: "http://127.0.0.1:4173/",
            mode: "control",
        });
        const imageId = await docker(
            "image",
            "inspect",
            "homelab-browser-worker-test:local",
            "--format",
            "{{.Id}}"
        );
        const config = path.join(temporary, "host.json");
        await Bun.write(
            config,
            JSON.stringify({ hostId: crypto.randomUUID(), socketPath, imageId })
        );
        host = Bun.spawn(
            [process.execPath, "--no-env-file", "apps/mira/dist/hostCli.js"],
            {
                env: {
                    PATH: "/usr/bin:/bin",
                    HOME: temporary,
                    HOMELAB_DASHBOARD_DATABASE_URL: allocation.url,
                    HOMELAB_MIRA_BROWSER_CONFIG: config,
                    HOMELAB_MIRA_BROWSER_HEALTH_PORT: String(healthPort),
                },
                stdin: "ignore",
                stdout: "ignore",
                stderr: "pipe",
            }
        );
        const lifetime = AbortSignal.timeout(90_000);
        const tools = createMiraTools(db.client, run);
        const invoke = (name: string, input: unknown) =>
            tools
                .find((tool) => tool.name === name)!
                .execute(input, lifetime, {
                    callId: crypto.randomUUID(),
                    threadId: "synthetic",
                    turnId: "synthetic",
                });
        const observe = async () => {
            const output: RuntimeToolResult = await invoke("mira_browser_observe", {});
            assert.notEqual(typeof output, "string");
            if (typeof output === "string")
                throw new Error("Native observation was unavailable.");
            const metadata = output.content[0];
            assert.equal(metadata?.type, "text");
            if (metadata?.type !== "text")
                throw new Error("Native metadata was unavailable.");
            assert.equal(output.content[1]?.type, "image");
            return (
                JSON.parse(metadata.text) as {
                    result: {
                        observationId: string;
                        refs: { ref: string; label: string; actions: string[] }[];
                    };
                }
            ).result;
        };
        const first = await observe();
        const [record] = await db.client<
            { containerId: string }[]
        >`SELECT container_id AS "containerId" FROM mira_browser_processes WHERE state='active'`;
        assert.ok(record);
        selected = record.containerId;
        const text = first.refs.find(
            (ref) => ref.label === "Fixture text" && ref.actions.includes("type")
        );
        assert.ok(text);
        const typed = await invoke("mira_browser_input", {
            action: "type",
            observationId: first.observationId,
            ref: text.ref,
            text: "literal <script> and quotes",
            replace: true,
        });
        assert.equal(typeof typed, "string");
        assert.deepEqual((JSON.parse(typed as string) as { result: unknown }).result, {
            effect: "unverified",
        });
        const next = await observe();
        const button = next.refs.find(
            (ref) => ref.label === "Count" && ref.actions.includes("click")
        );
        assert.ok(button);
        const clicked = await invoke("mira_browser_input", {
            action: "click",
            observationId: next.observationId,
            ref: button.ref,
        });
        assert.equal(typeof clicked, "string");
        assert.deepEqual((JSON.parse(clicked as string) as { result: unknown }).result, {
            effect: "unverified",
        });
        let evidence: { text: string; count: number; trusted: boolean } | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                evidence = JSON.parse(
                    await docker(
                        "exec",
                        selected,
                        "cat",
                        "/tmp/mira-browser-worker-events.json"
                    )
                ) as typeof evidence;
            } catch {
                /* The synthetic site may still be writing its receipt. */
            }
            if (evidence?.count === 1) break;
            await Bun.sleep(20);
        }
        assert.deepEqual(evidence, {
            text: "literal <script> and quotes",
            count: 1,
            trusted: true,
        });
        const ready = await fetch(`http://127.0.0.1:${healthPort}/health/ready`);
        assert.equal(ready.status, 200);
        host.kill("SIGTERM");
        assert.equal(await host.exited, 0);
        assert.ok(host.stderr instanceof ReadableStream);
        assert.equal(await new Response(host.stderr).text(), "");
        await assert.rejects(docker("inspect", selected));
        const [finished] = await db.client<
            { state: string; access: string }[]
        >`SELECT p.state,g.state AS access FROM mira_browser_processes p JOIN mira_browser_access g ON g.id=p.access_id`;
        assert.deepEqual(finished, { state: "removed", access: "closed" });
        const [commands] = await db.client<
            { count: number; scrubbed: boolean }[]
        >`SELECT count(*)::int AS count,bool_and(state='consumed' AND payload IS NULL AND result IS NULL) AS scrubbed FROM mira_browser_commands`;
        assert.deepEqual(commands, { count: 4, scrubbed: true });
        process.stdout.write(
            JSON.stringify({
                builtHost: true,
                durableQueue: true,
                realTabImages: true,
                trustedType: true,
                trustedClick: true,
                shutdownCleanup: true,
                transientContentErased: true,
            }) + "\n"
        );
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (host && host.exitCode === null) {
            host.kill("SIGTERM");
            await host.exited;
        }
        if (selected) await docker("rm", "-f", selected).catch(() => {});
        await db.client.close();
        await allocation.close();
        await rm(temporary, { recursive: true, force: true });
    }
}
if (import.meta.main) await main();
