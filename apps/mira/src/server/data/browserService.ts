import { setTimeout as delay } from "node:timers/promises";

import type { SQL } from "bun";
import * as v from "valibot";

import { lockBrowserOwner } from "./browserAccess";
import {
    claimMiraBrowserCommand,
    cleanupMiraBrowserCommands,
    finishMiraBrowserCommand,
    pendingMiraBrowsers,
} from "./browserCommands";
import {
    claimBrowserHumanCommand,
    finishBrowserHumanCommand,
} from "./browserConsoleHost";
import { saveBrowserDownload } from "./browserDownloads";
import {
    browserHostConfigurationSchema,
    openMiraBrowserSession,
    recoverMiraBrowserProcesses,
} from "./browserHost";
import { retireBrowserCommands } from "./browserRetirement";
import { readMiraFile } from "./files";

export interface MiraBrowserHealth {
    ready: boolean;
    heartbeatAt: number;
    active: number;
    unresolved: number;
}

/**
 * Run the trusted local browser host independently of model execution and its queue.
 * @param options - Private database, fixed engine selection and permanent service cancellation.
 * @param dependencies - Synthetic session/recovery factories for isolated qualification only.
 * @returns Completion after every owned session closes; uncertain cleanup remains durably reserved.
 */
export async function runMiraBrowserHost(
    options: {
        client: SQL;
        configuration: unknown;
        signal: AbortSignal;
        health: MiraBrowserHealth;
        filesDirectory?: string | undefined;
    },
    dependencies: {
        open?: typeof openMiraBrowserSession;
        recover?: typeof recoverMiraBrowserProcesses;
    } = {}
): Promise<void> {
    const config = v.parse(browserHostConfigurationSchema, options.configuration);
    const { client, signal, health } = options;
    const controller = new AbortController();
    const lifetime = AbortSignal.any([signal, controller.signal]);
    const tasks = new Map<string, Promise<void>>();
    const open = dependencies.open ?? openMiraBrowserSession;
    const recover = dependencies.recover ?? recoverMiraBrowserProcesses;
    let nextRecovery = 0;
    const execute = async (
        candidate: Awaited<ReturnType<typeof pendingMiraBrowsers>>[number]
    ) => {
        const context = {
            client,
            owner: candidate.owner,
            actor: "browser:host",
            run: { id: candidate.runId, leaseToken: candidate.runLease },
        };
        let session: Awaited<ReturnType<typeof open>> | undefined;
        let cleanupFailed: boolean;
        try {
            session = await open(context, candidate.id, config, lifetime);
            const current = session;
            const running = AbortSignal.any([lifetime, current.signal]);
            while (!running.aborted) {
                const started = performance.now();
                const humanCommand = await claimBrowserHumanCommand(
                    client,
                    current.claim
                );
                const command =
                    humanCommand ??
                    (await claimMiraBrowserCommand(client, current.claim));
                running.throwIfAborted();
                if (!command) {
                    await delay(100, undefined, { signal: running });
                    continue;
                }
                const remaining = command.validForMs - (performance.now() - started);
                if (remaining <= 0)
                    throw new Error("Browser command expired before dispatch.");
                const operation = AbortSignal.any([
                    running,
                    AbortSignal.timeout(Math.max(1, Math.floor(remaining))),
                ]);
                let result: unknown;
                if (command.operation.method === "observe")
                    result = await current.observe(operation, Boolean(humanCommand));
                else if (command.operation.method === "tabs")
                    result = await current.tabs(
                        command.operation.input,
                        operation,
                        Boolean(humanCommand)
                    );
                else if (command.operation.method === "navigate")
                    result = await current.navigate(command.operation.url, operation);
                else if (command.operation.method === "download") {
                    if (!humanCommand)
                        throw new Error("Only a human can request browser downloads.");
                    const file = await current.download(
                        command.operation.input,
                        operation
                    );
                    operation.throwIfAborted();
                    await saveBrowserDownload(
                        client,
                        current.claim,
                        humanCommand,
                        options.filesDirectory,
                        file,
                        operation
                    );
                    continue;
                } else if (command.operation.method === "upload") {
                    if (!humanCommand)
                        throw new Error("Only a human can select browser uploads.");
                    const selected = command.operation.file;
                    const file = await readMiraFile(
                        context,
                        options.filesDirectory,
                        selected.id
                    );
                    operation.throwIfAborted();
                    if (
                        file.metadata.name !== selected.name ||
                        file.metadata.bytes !== selected.size ||
                        new Bun.CryptoHasher("sha256")
                            .update(file.bytes)
                            .digest("hex") !== selected.sha256
                    )
                        throw new Error("The confirmed attachment has changed.");
                    result = await current.upload(
                        command.operation.input,
                        {
                            name: selected.name,
                            size: selected.size,
                            sha256: selected.sha256,
                            bytes: file.bytes,
                        },
                        operation
                    );
                } else result = await current.act(command.operation.input, operation);
                operation.throwIfAborted();
                if (
                    !(humanCommand
                        ? await finishBrowserHumanCommand(
                              client,
                              current.claim,
                              humanCommand,
                              result
                          )
                        : await finishMiraBrowserCommand(
                              client,
                              current.claim,
                              command.id,
                              result
                          ))
                )
                    throw new Error("Browser result lost its authority.");
            }
        } finally {
            // Revocation and cleanup are independent: a failed database write must
            // never prevent the local process from being stopped.
            const results = await Promise.allSettled([
                session
                    ? client.begin(async (query) => {
                          await lockBrowserOwner(query, candidate.owner);
                          await retireBrowserCommands(
                              query,
                              candidate.owner,
                              candidate.id
                          );
                      })
                    : Promise.resolve(),
                session?.close() ?? Promise.resolve(),
            ]);
            cleanupFailed = results.some((result) => result.status === "rejected");
        }
        if (cleanupFailed) throw new Error("Browser session cleanup remains pending.");
    };
    try {
        while (!lifetime.aborted) {
            await cleanupMiraBrowserCommands(client);
            if (Date.now() >= nextRecovery) {
                const recovered = await recover(client, config);
                health.unresolved = recovered.unresolved;
                nextRecovery = Date.now() + 5000;
            }
            lifetime.throwIfAborted();
            const candidates = await pendingMiraBrowsers(client);
            for (const candidate of candidates) {
                if (tasks.size >= 2 || lifetime.aborted) break;
                if (tasks.has(candidate.id)) continue;
                const task = execute(candidate)
                    .catch(() => {
                        health.unresolved++;
                    })
                    .finally(() => {
                        tasks.delete(candidate.id);
                        health.active = tasks.size;
                    });
                tasks.set(candidate.id, task);
                health.active = tasks.size;
            }
            health.ready = true;
            health.heartbeatAt = Date.now();
            await delay(250, undefined, { signal: lifetime });
        }
    } catch (error) {
        if (!lifetime.aborted) throw error;
    } finally {
        health.ready = false;
        controller.abort();
        await Promise.allSettled(tasks.values());
        health.active = 0;
    }
}
