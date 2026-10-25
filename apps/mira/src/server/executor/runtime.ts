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
import {
    hereNowBindingHash,
    type HereNowReadConfiguration,
} from "../integrations/herenow/configuration";
import {
    dispatchMiraPublication,
    reconcileMiraPublications,
} from "../integrations/herenow/outbox";
import {
    moltbookBindingHash,
    type MoltbookReadConfiguration,
} from "../integrations/moltbook/configuration";
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
    moltbook?: MoltbookReadConfiguration | undefined;
    hereNow?: HereNowReadConfiguration | undefined;
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
                  sendConfigured: Boolean(options.agentMail.sendApiKey),
              },
          ]
        : [];
    if (options.moltbook)
        integrationsCatalog.push({
            owner: options.moltbook.owner,
            key: "moltbook",
            bindingHash: moltbookBindingHash(options.moltbook),
            sendConfigured: false,
        });
    if (options.hereNow)
        integrationsCatalog.push({
            owner: options.hereNow.owner,
            key: "here-now",
            bindingHash: hereNowBindingHash(options.hereNow),
            sendConfigured: Boolean(options.hereNow.publishApiKey),
        });
    let model: string | null = null;
    let models: MiraModel[] = [];
    let defaultReady = false;
    let message: string | null = null;
    let cleanupPending = false;
    let inspectionChanged = Promise.withResolvers<void>();
    const wait = async (ms: number) => {
        try {
            await delay(ms, undefined, { signal });
        } catch {
            signal.throwIfAborted();
        }
    };
    const coordinator = async () => {
        while (!signal.aborted) {
            const changed = inspectionChanged.promise;
            await reconcileMiraRuns(client);
            const currentMessage =
                health.ready && cleanupPending
                    ? "Mira is connected, but deleted-data cleanup needs attention."
                    : message;
            await client`INSERT INTO mira_runtime_status (id, worker_id, version, model, ready, message, heartbeat_at, models, integrations) VALUES (1, ${workerId}, ${options.version}, ${model}, ${health.ready}, ${currentMessage}, now(), ${JSON.stringify(models)}::text::jsonb, ${JSON.stringify(integrationsCatalog)}::text::jsonb) ON CONFLICT (id) DO UPDATE SET worker_id = EXCLUDED.worker_id, version = EXCLUDED.version, model = EXCLUDED.model, ready = EXCLUDED.ready, message = EXCLUDED.message, heartbeat_at = EXCLUDED.heartbeat_at, models = EXCLUDED.models, integrations = EXCLUDED.integrations`;
            health.heartbeatAt = Date.now();
            await Promise.race([wait(5000), changed]);
        }
    };
    // Fan-out and schedule reconciliation can wait on many subscribers or control locks.
    // Their progress must not own readiness or prevent explicit foreground chat claims.
    const scheduler = async () => {
        while (!signal.aborted) {
            const changed = inspectionChanged.promise;
            await reconcileMiraControls(client);
            if (health.ready && defaultReady) await scheduleMiraRuns(client);
            await Promise.race([wait(5000), changed]);
        }
    };
    const inspector = async () => {
        while (!signal.aborted) {
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
                const availableModels = account.authenticated
                    ? await runtime.models()
                    : [];
                models = availableModels;
                model =
                    config.model ??
                    models.find((entry) => entry.isDefault)?.model ??
                    null;
                defaultReady = models.some((entry) => entry.model === model);
                // Explicit available chats remain usable while default work waits.
                health.ready = account.authenticated && models.length > 0;
                const defaultMessage = defaultReady
                    ? null
                    : "The default model is unavailable. Automatic work is waiting; choose an available model in Chat settings.";
                message = health.ready
                    ? defaultMessage
                    : "Mira needs its own ChatGPT sign-in and an available model.";
            } catch {
                health.ready = false;
                message =
                    "The Mira runtime is unavailable. Queued work has not been started.";
            } finally {
                inspectionChanged.resolve();
                inspectionChanged = Promise.withResolvers<void>();
                await runtime?.close();
            }
            await wait(30_000);
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
    const publicationDelivery = async () => {
        while (!signal.aborted) {
            await reconcileMiraPublications(client, options.hereNow);
            if (options.hereNow)
                await dispatchMiraPublication(
                    client,
                    options.hereNow,
                    signal,
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
                const run = await claimMiraRun(client, workerId, name, {
                    models: models.map((entry) => entry.model),
                    defaultModel: model,
                });
                if (run) {
                    health.active++;
                    try {
                        await executeMiraTurn(
                            client,
                            config,
                            run,
                            signal,
                            options.filesDirectory,
                            options.agentMail,
                            options.moltbook,
                            options.hereNow
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
        stopOnFailure(publicationDelivery()),
        stopOnFailure(scheduler()),
        stopOnFailure(inspector()),
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
