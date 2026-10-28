import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { sandboxSmokeEnvironment } from "../../../../mira/src/server/config/environment";
import {
    changeConversation,
    createConversation,
    enqueueTurn,
    readConversation,
} from "../../../../mira/src/server/data/conversations";
import { saveMiraFile } from "../../../../mira/src/server/data/files";
import { syntheticPdf } from "../../../../mira/src/server/testing/document";
import { syntheticRedImage } from "../../../../mira/src/server/testing/image";
import { connectDashboardDatabase } from "../database/connection";
import { migrateDashboard } from "../database/migrations";

function milestone(message: string) {
    process.stdout.write(message + "\n");
}

async function docker(args: string[]): Promise<string> {
    const child = Bun.spawn(["docker", ...args], {
        env: sandboxSmokeEnvironment(),
        stdout: "pipe",
        stderr: "ignore",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
    try {
        const [code, output] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
        ]);
        assert.equal(
            code,
            0,
            `Docker ${args[0]} failed; retained fixtures need inspection.`
        );
        return output.trim();
    } finally {
        clearTimeout(deadline);
    }
}

async function until(
    signal: AbortSignal,
    label: string,
    test: () => Promise<boolean>,
    ms = 90_000
) {
    const deadline = Date.now() + ms;
    do {
        signal.throwIfAborted();
        if (await test()) return;
        await delay(1000, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}.`);
}

/**
 * Exercise the shipped executor with a dedicated ChatGPT profile and disposable product data.
 * @returns Completion after queue recovery, conversation continuation and provider deletion.
 */
export async function main(): Promise<void> {
    const [image, home, model] = process.argv.slice(2);
    if (
        !image ||
        !home ||
        ![4, 5].includes(process.argv.length) ||
        process.platform !== "linux"
    )
        throw new Error(
            "Usage on Linux: bun run mira:qualify-container LOCAL_IMAGE /absolute/dedicated-codex-home [MODEL]"
        );
    assert.ok(path.isAbsolute(home), "The dedicated profile must be an absolute path.");
    assert.equal(
        process.getuid?.(),
        1000,
        "Run qualification as the profile owner (UID 1000)."
    );
    const profile = await realpath(home);
    const metadata = await stat(profile);
    assert.ok(
        metadata.isDirectory() && metadata.uid === 1000,
        "The profile must belong to container UID 1000."
    );
    assert.equal(metadata.mode & 0o077, 0, "The dedicated profile must be private.");
    // Resolve only already-built images; never pull, rebuild or substitute a mutable tag mid-test.
    const artifact = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
    const postgres = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        "postgres:18",
    ]);
    const name = `mira-qualification-${crypto.randomUUID()}`;
    const directory = await mkdtemp(path.join(tmpdir(), `${name}-`));
    await chmod(directory, 0o700);
    const files = path.join(directory, "files");
    await mkdir(files, { mode: 0o700 });
    const config = path.join(directory, "runtime.json");
    await Bun.write(
        config,
        JSON.stringify({
            command: "/app/runtime/codex",
            codexHome: "/var/lib/mira/codex",
            workspace: "/var/empty/mira",
            ...(model ? { model } : {}),
        })
    );
    await chmod(config, 0o600);
    let network: string | undefined;
    let volume: string | undefined;
    let postgresContainer: string | undefined;
    let executor: string | undefined;
    let database: ReturnType<typeof connectDashboardDatabase> | undefined;
    let passed = false;
    const cancelled = new AbortController();
    const cancel = () => cancelled.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    const stop = async (id: string) => {
        await docker(["stop", "--time", "35", id]);
        const state = await docker([
            "inspect",
            "--format",
            "{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            id,
        ]);
        assert.equal(state, "false 0 false", "Executor shutdown did not finish cleanly.");
    };
    try {
        network = await docker(["network", "create", name]);
        volume = await docker(["volume", "create", `${name}-database`]);
        postgresContainer = await docker([
            "run",
            "--pull=never",
            "-d",
            "--name",
            `${name}-database`,
            "--network",
            network,
            "--network-alias",
            "database",
            "--cpus",
            "2",
            "--memory",
            "768m",
            "--mount",
            `type=volume,source=${volume},target=/var/lib/postgresql`,
            "-p",
            "127.0.0.1::5432",
            "-e",
            "POSTGRES_USER=homelab_test",
            "-e",
            "POSTGRES_PASSWORD=synthetic-qualification-only",
            "-e",
            "POSTGRES_DB=homelab_auth_test",
            postgres,
        ]);
        const port = await docker(["port", postgresContainer, "5432/tcp"]);
        assert.match(port, /^127\.0\.0\.1:\d+$/);
        const url = `postgres://homelab_test:synthetic-qualification-only@${port}/homelab_auth_test`;
        database = connectDashboardDatabase(url, 6);
        const client = database.client;
        await until(cancelled.signal, "disposable database startup", async () => {
            try {
                await client`SELECT 1`;
                return true;
            } catch {
                return false;
            }
        });
        await migrateDashboard(database);
        const internalUrl = new URL(url);
        internalUrl.hostname = "database";
        internalUrl.port = "5432";
        const start = async (previousWorker?: string) => {
            executor = await docker([
                "run",
                "--pull=never",
                "-d",
                "--name",
                `${name}-executor-${crypto.randomUUID()}`,
                "--network",
                network!,
                "--init",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--cpus",
                "2",
                "--memory",
                "2g",
                "--pids-limit",
                "128",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=128m",
                "--mount",
                `type=bind,source=${profile},target=/var/lib/mira/codex`,
                "--mount",
                `type=bind,source=${files},target=/var/lib/mira/files`,
                "--mount",
                `type=bind,source=${config},target=/etc/homelab-mira/runtime.json,readonly`,
                "-e",
                "HOMELAB_MIRA_CONFIG=/etc/homelab-mira/runtime.json",
                "-e",
                "HOMELAB_MIRA_FILES_DIR=/var/lib/mira/files",
                "-e",
                `HOMELAB_DASHBOARD_DATABASE_URL=${internalUrl.href}`,
                artifact,
            ]);
            await until(
                cancelled.signal,
                "container authentication and model catalog",
                async () => {
                    assert.equal(
                        await docker([
                            "inspect",
                            "--format",
                            "{{.State.Running}}",
                            executor!,
                        ]),
                        "true",
                        "Executor exited before readiness."
                    );
                    const [runtime] = await client<
                        { worker: string; ready: boolean; models: unknown[] }[]
                    >`SELECT worker_id AS worker,ready,models FROM mira_runtime_status WHERE heartbeat_at>now()-interval '15 seconds'`;
                    return Boolean(
                        runtime?.ready &&
                        runtime.models.length > 0 &&
                        runtime.worker !== previousWorker
                    );
                }
            );
            await docker([
                "exec",
                executor,
                "bun",
                "--no-env-file",
                "-e",
                "const r=await fetch('http://127.0.0.1:3440/health/ready');if(r.status!==200)process.exit(1)",
            ]);
            const [runtime] = await client<
                { worker: string; models: { model: string }[] }[]
            >`SELECT worker_id AS worker,models FROM mira_runtime_status`;
            assert.ok(runtime);
            if (model)
                assert.ok(
                    runtime.models.some((entry) => entry.model === model),
                    "The explicitly selected qualification model is unavailable."
                );
            milestone(
                `Passed packaged runtime readiness with ${runtime.models.length} advertised models.`
            );
            return runtime.worker;
        };
        const worker = await start();
        const context = {
            client,
            owner: "synthetic-container-qualification",
            actor: "human:synthetic-container-qualification",
        };
        const marker = crypto.randomUUID();
        const attachments = [];
        for (const [filename, bytes] of [
            ["marker.txt", new TextEncoder().encode(`Synthetic marker: ${marker}`)],
            ["document.pdf", syntheticPdf()],
            ["colour.png", syntheticRedImage()],
        ] as const)
            attachments.push(
                await saveMiraFile(context, files, {
                    id: crypto.randomUUID(),
                    name: filename,
                    bytes,
                })
            );
        const conversation = await createConversation(
            context,
            "Synthetic container qualification"
        );
        const enqueue = (text: string, attachmentIds: string[] = []) =>
            client.begin((query) =>
                enqueueTurn(query, context, {
                    conversationId: conversation.id,
                    requestId: crypto.randomUUID(),
                    text,
                    attachmentIds,
                })
            );
        const completed = async (runId: string) => {
            await until(
                cancelled.signal,
                "durable queued turn",
                async () => {
                    const [run] = await client<
                        { state: string }[]
                    >`SELECT state FROM mira_runs WHERE id=${runId}`;
                    assert.ok(run);
                    assert.ok(
                        ["queued", "running", "completed"].includes(run.state),
                        `Qualification run ended ${run.state}.`
                    );
                    return run.state === "completed";
                },
                180_000
            );
            const result = await readConversation(context, conversation.id);
            return result.messages.at(-1)?.content ?? "";
        };
        const first = await enqueue(
            "This is a synthetic qualification. Read the attached text and PDF, and inspect the image. Call mira_tasks_list once with an empty search. Reply in English with the exact marker from the text, the phrase printed in the PDF, and the image's dominant colour. Remember the marker for the next turn.",
            attachments.map((entry) => entry.id)
        );
        const answer = await completed(first.id);
        assert.ok(answer.includes(marker), "Text attachment marker missing.");
        assert.match(answer, /Synthetic Mira document/i);
        assert.match(answer, /\bred\b/i, "Image was not recognized.");
        const [receipt] = await client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_tool_receipts WHERE run_id=${first.id} AND tool='mira_tasks_list' AND state='succeeded'`;
        assert.ok(receipt && receipt.count > 0, "Recorded product tool missing.");
        const [history] = await client<
            { thread: string }[]
        >`SELECT provider_thread AS thread FROM mira_conversations WHERE id=${conversation.id}`;
        assert.ok(history?.thread);
        milestone(
            "Passed actual service queue, text/PDF/image attachments and recorded product tool."
        );
        await stop(executor!);
        await docker(["rm", executor!]);
        executor = undefined;
        const second = await enqueue(
            "Repeat the marker from the previous message exactly. Do not read files or call tools."
        );
        const [queued] = await client<
            { state: string }[]
        >`SELECT state FROM mira_runs WHERE id=${second.id}`;
        assert.equal(queued?.state, "queued");
        await start(worker);
        const continuation = await completed(second.id);
        assert.ok(
            continuation.includes(marker),
            "Container replacement lost conversation context."
        );
        const [resumed] = await client<
            { thread: string; worker: string }[]
        >`SELECT c.provider_thread AS thread,r.worker_id AS worker FROM mira_conversations c JOIN mira_runs r ON r.conversation_id=c.id WHERE r.id=${second.id}`;
        assert.equal(resumed?.thread, history.thread);
        assert.notEqual(resumed?.worker, worker);
        milestone(
            "Passed queued-while-stopped delivery and provider thread continuation in a replacement container."
        );
        const current = await readConversation(context, conversation.id);
        await changeConversation(context, {
            id: conversation.id,
            version: current.conversation.version,
            action: "delete",
        });
        await until(cancelled.signal, "provider history deletion", async () => {
            const [row] = await client<
                { clean: boolean }[]
            >`SELECT provider_thread IS NULL AS clean FROM mira_conversations WHERE id=${conversation.id} AND deleted_at IS NOT NULL`;
            return row?.clean === true;
        });
        await stop(executor!);
        await docker(["rm", executor!]);
        executor = undefined;
        milestone("Passed provider deletion and graceful service shutdown.");
        passed = true;
    } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
        const cleanup = await Promise.allSettled([
            database?.client.close(),
            executor ? docker(["stop", "--time", "35", executor]) : undefined,
        ]);
        cleanup.push(
            ...(await Promise.allSettled([
                postgresContainer
                    ? docker(["stop", "--time", "20", postgresContainer])
                    : undefined,
            ]))
        );
        const stopped = cleanup.every((outcome) => outcome.status === "fulfilled");
        if (passed && stopped) {
            if (postgresContainer) await docker(["rm", postgresContainer]);
            if (volume) await docker(["volume", "rm", volume]);
            if (network) await docker(["network", "rm", network]);
            await rm(directory, { recursive: true, force: true });
        } else {
            await Bun.write(
                path.join(directory, "retained.json"),
                JSON.stringify({
                    artifact,
                    network,
                    volume,
                    postgresContainer,
                    executor,
                    stopped,
                })
            );
            process.stderr.write(
                `Qualification failed. Fixtures ${name} and files ${directory} are retained for inspection and provider cleanup. Do not delete them before accounting for pending history. Shutdown confirmed: ${stopped}.\n`
            );
        }
        assert.ok(stopped, "Fixture shutdown needs operator attention.");
    }
}

if (import.meta.main) await main();
