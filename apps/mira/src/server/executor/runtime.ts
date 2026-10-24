import { setTimeout as delay } from "node:timers/promises";

import type { MiraModel } from "@homelab/contracts/mira";
import type { SQL } from "bun";

import { runtimeEnvironment } from "../config/environment";
import { reconcileMiraControls } from "../data/automations";
import { claimMiraRun, reconcileMiraRuns, scheduleMiraRuns } from "../data/queue";
import {
    agentMailBindingHash,
    type AgentMailReadConfiguration,
} from "../integrations/agentmail/configuration";
import { dispatchMiraMail, reconcileMiraMail } from "../integrations/agentmail/outbox";
import { pollAgentMail } from "../integrations/agentmail/poll";
import { AgentMailReader } from "../integrations/agentmail/reader";
import { CodexRuntime } from "../runtime/codexRuntime";
import { pilotArguments, type PilotConfig } from "../runtime/configuration";
import { cleanupMiraResources } from "./cleanup";
import { executeMiraTurn } from "./turn";

export interface MiraHealth {
    ready: boolean;
    heartbeatAt: number;
    draining: boolean;
    active: number;
}

/**
 * Run two agent lanes and a durable scheduler without using infrastructure workers.
 * @param options - Owned database, canonical runtime paths, health state and shutdown signal.
 * @returns Completion when dispatch stops and all active provider children are reaped.
 */
export async function runMiraExecutor(options: {
    client: SQL;
    config: PilotConfig;
    version: string;
    signal: AbortSignal;
    health: MiraHealth;
    filesDirectory?: string | undefined;
    agentMail?: AgentMailReadConfiguration | undefined;
}): Promise<void> {
    const { client, config, health } = options;
    const failed = new AbortController();
    const signal = AbortSignal.any([options.signal, failed.signal]);
    const workerId = crypto.randomUUID();
    const reader = options.agentMail ? new AgentMailReader(options.agentMail) : undefined;
    const integrationsCatalog = options.agentMail
        ? [
              {
                  owner: options.agentMail.owner,
                  key: "agentmail",
                  bindingHash: agentMailBindingHash(options.agentMail),
              },
          ]
        : [];
    let inspectedAt = 0;
    let model: string | null = null;
    let models: MiraModel[] = [];
    let message: string | null = null;
    let cleanupPending = false;
    const wait = async (ms: number) => {
        try {
            await delay(ms, undefined, { signal });
        } catch {
            signal.throwIfAborted();
        }
    };
    const coordinator = async () => {
        while (!signal.aborted) {
            await reconcileMiraRuns(client);
            await reconcileMiraControls(client);
            if (Date.now() - inspectedAt >= 30_000) {
                let runtime: CodexRuntime | undefined;
                try {
                    runtime = await CodexRuntime.connect({
                        command: config.command,
                        args: pilotArguments(),
                        cwd: config.workspace,
                        env: runtimeEnvironment(config),
                        requestTimeoutMs: 5000,
                        signal,
                    });
                    const account = await runtime.account();
                    health.ready = account.authenticated;
                    models = account.authenticated ? await runtime.models() : [];
                    model =
                        config.model ??
                        models.find((entry) => entry.isDefault)?.model ??
                        null;
                    // A missing deployment default must not block explicit available choices.
                    // Each turn validates its own frozen selection before starting inference.
                    health.ready &&= models.length > 0;
                    message = health.ready
                        ? null
                        : "Mira needs its own ChatGPT sign-in and an available model.";
                } catch {
                    health.ready = false;
                    message =
                        "The Mira runtime is unavailable. Queued work has not been started.";
                } finally {
                    await runtime?.close();
                }
                inspectedAt = Date.now();
            }
            const currentMessage =
                health.ready && cleanupPending
                    ? "Mira is connected, but deleted-data cleanup needs attention."
                    : message;
            await client`INSERT INTO mira_runtime_status (id, worker_id, version, model, ready, message, heartbeat_at, models, integrations) VALUES (1, ${workerId}, ${options.version}, ${model}, ${health.ready}, ${currentMessage}, now(), ${JSON.stringify(models)}::text::jsonb, ${JSON.stringify(integrationsCatalog)}::text::jsonb) ON CONFLICT (id) DO UPDATE SET worker_id = EXCLUDED.worker_id, version = EXCLUDED.version, model = EXCLUDED.model, ready = EXCLUDED.ready, message = EXCLUDED.message, heartbeat_at = EXCLUDED.heartbeat_at, models = EXCLUDED.models, integrations = EXCLUDED.integrations`;
            if (health.ready) await scheduleMiraRuns(client);
            health.heartbeatAt = Date.now();
            await wait(5000);
        }
    };
    const integrations = async () => {
        while (!signal.aborted) {
            if (reader && options.agentMail)
                await pollAgentMail(client, options.agentMail, reader, signal);
            await wait(5000);
        }
    };
    const mailDelivery = async () => {
        while (!signal.aborted) {
            await reconcileMiraMail(client, options.agentMail);
            if (options.agentMail)
                await dispatchMiraMail(
                    client,
                    options.agentMail,
                    signal,
                    fetch,
                    options.filesDirectory
                );
            await wait(5000);
        }
    };
    const cleaner = async () => {
        while (!signal.aborted) {
            let runtime: CodexRuntime | undefined;
            try {
                try {
                    runtime = await CodexRuntime.connect({
                        command: config.command,
                        args: pilotArguments(),
                        cwd: config.workspace,
                        env: runtimeEnvironment(config),
                        requestTimeoutMs: 5000,
                        signal,
                    });
                } catch {
                    // Local deleted content is still cleaned while the provider is unavailable.
                }
                const cleaned = await cleanupMiraResources({
                    client,
                    runtime,
                    filesDirectory: options.filesDirectory,
                    home: config.codexHome,
                });
                cleanupPending = !runtime || !cleaned;
            } finally {
                await runtime?.close();
            }
            await wait(30_000);
        }
    };
    const lane = async (name: "foreground" | "general") => {
        while (!signal.aborted) {
            if (health.ready && Date.now() - health.heartbeatAt < 30_000) {
                const run = await claimMiraRun(client, workerId, name);
                if (run) {
                    health.active++;
                    try {
                        await executeMiraTurn(
                            client,
                            config,
                            run,
                            signal,
                            options.filesDirectory,
                            options.agentMail
                        );
                    } finally {
                        health.active--;
                    }
                    continue;
                }
            }
            await wait(500);
        }
    };
    const stopOnFailure = async (work: Promise<void>) => {
        try {
            await work;
        } catch (error) {
            failed.abort();
            throw error;
        }
    };
    const outcomes = await Promise.allSettled([
        stopOnFailure(coordinator()),
        stopOnFailure(integrations()),
        stopOnFailure(mailDelivery()),
        stopOnFailure(cleaner()),
        stopOnFailure(lane("foreground")),
        stopOnFailure(lane("general")),
    ]);
    if (
        !options.signal.aborted &&
        outcomes.some((result) => result.status === "rejected")
    )
        throw new Error("Mira executor stopped unexpectedly.");
}
