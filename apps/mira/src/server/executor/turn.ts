import type { MiraActivity, MiraMessagePart } from "@homelab/contracts/mira";
import type { SQL } from "bun";
import * as v from "valibot";

import { runtimeEnvironment } from "../config/environment";
import { miraRunPermission } from "../data/approvalPolicy";
import { resolveMiraChatSettings } from "../data/chatSettings";
import { claimChatSteering, acknowledgeChatSteering } from "../data/chatSteering";
import { readMiraComputerReadiness } from "../data/computerWait";
import { MiraFailure } from "../data/context";
import {
    liveAssistanceMinutes,
    readLiveAssistanceGuidance,
} from "../data/liveAssistance";
import {
    finishMiraRun,
    renewMiraRun,
    saveMiraDelta,
    saveMiraActivity,
    type MiraClaim,
} from "../data/queue";
import { readMiraRecallContext, readMiraRecallPolicy } from "../data/recall";
import { readTaskSteering, acknowledgeTaskSteering } from "../data/taskSteering";
import type { AgentMailReadConfiguration } from "../integrations/agentmail/configuration";
import type { DaytonaBinding } from "../integrations/daytona/configuration";
import type {
    GitHubBinding,
    GitHubConfiguration,
} from "../integrations/github/configuration";
import type { HereNowReadConfiguration } from "../integrations/herenow/configuration";
import type { MoltbookReadConfiguration } from "../integrations/moltbook/configuration";
import {
    miraInstructions as instructions,
    miraInstructionsHash,
} from "../persona/instructions";
import { CodexRuntime } from "../runtime/codexRuntime";
import { pilotArguments, type PilotConfig } from "../runtime/configuration";
import { RuntimeResponseError } from "../runtime/responseError";
import { isSyntheticModel } from "../runtime/syntheticCatalog";
import type { SyntheticConfiguration } from "../runtime/syntheticConfiguration";
import { SyntheticRuntime, loadSyntheticModels } from "../runtime/syntheticRuntime";
import { createMiraToolRouter } from "../runtime/toolRouter";
import type { LocalCodeBinding } from "../sandbox/localBinding";
import { prepareMiraAttachments } from "./attachments";
import { readMiraTurnInput } from "./context";
import { waitForLiveAssistance } from "./liveAssistance";
import { createMiraTools } from "./tools";

export { miraInstructionsHash } from "../persona/instructions";

/**
 * Execute one fenced chat turn independently of the dashboard request and worker queue.
 * @param client - Dedicated agent database pool.
 * @param config - Validated canonical native runtime configuration.
 * @param run - Durable claim whose lease is renewed during inference.
 * @param stopping - Executor shutdown signal, translated into provider interruption.
 * @param filesDirectory - Explicit shared attachment volume, absent until provisioned.
 * @param agentMail - Optional inbox settings, never forwarded to the model child.
 * @param hereNow - Optional scoped website metadata settings; credentials stay in the executor.
 * @param moltbook - Optional social read settings, retained only by the service.
 * @param github - Optional GitHub mapping and dedicated read credential, retained only in the service closure.
 * @param synthetic - Optional owner-bound Synthetic subscription credential, retained only by the server.
 * @param localCode - Optional Main mapping; the run freezes its target before inference.
 * @param daytona - Nonsecret cloud mapping for local drafts and result reads.
 * @returns Completion after recording the observed terminal outcome and reaping the child.
 */
export async function executeMiraTurn(
    client: SQL,
    config: PilotConfig,
    run: MiraClaim,
    stopping: AbortSignal,
    filesDirectory?: string,
    agentMail?: AgentMailReadConfiguration,
    moltbook?: MoltbookReadConfiguration,
    hereNow?: HereNowReadConfiguration,
    daytona?: DaytonaBinding,
    github?: GitHubBinding | GitHubConfiguration,
    synthetic?: SyntheticConfiguration,
    localCode?: LocalCodeBinding
): Promise<void> {
    const controller = new AbortController();
    const deadline = new AbortController();
    const deadlineAt = run.deadlineAt ?? Date.now() + run.budgetSeconds * 1000;
    const timer = setTimeout(
        () => deadline.abort(),
        Math.max(0, deadlineAt - Date.now())
    );
    const signal = AbortSignal.any([stopping, controller.signal, deadline.signal]);
    let runtime: CodexRuntime | SyntheticRuntime | undefined;
    let providerThread: string | undefined;
    let providerTurn: string | undefined;
    let steeringFailed = false;
    let assistance = false;
    let assistanceIdle = false;
    let assistanceFinished = false;
    let replyLimitFailure: MiraFailure | undefined;
    const transport = new AbortController();
    let stopTransportTimer: ReturnType<typeof setTimeout> | undefined;
    const stopTransport = () => {
        // Active turns need a short window to acknowledge interruption; host tools stop immediately.
        if (providerTurn) stopTransportTimer = setTimeout(() => transport.abort(), 5000);
        else transport.abort();
    };
    signal.addEventListener("abort", stopTransport, { once: true });
    if (signal.aborted) stopTransport();
    let attachments: Awaited<ReturnType<typeof prepareMiraAttachments>> | undefined;
    let activity: MiraActivity = { phase: "starting", tool: null };
    let savedActivity = "";
    let text = "";
    const parts: MiraMessagePart[] = [];
    let messageId: string | undefined;
    let persisted = "";
    let updating = false;
    let renewing = false;
    let renewal: Promise<void> = Promise.resolve();
    let update: Promise<void> = Promise.resolve();
    const interval = setInterval(() => {
        if (renewing) return;
        renewing = true;
        renewal = renewMiraRun(client, run)
            .then(async (allowed) => {
                if (!allowed) {
                    controller.abort();
                    return;
                }
                if (!runtime || !providerThread || !providerTurn || signal.aborted)
                    return;
                const edit = await readTaskSteering(client, run);
                if (signal.aborted) return;
                if (edit) {
                    let accepted: boolean;
                    try {
                        accepted = await runtime.steer(
                            providerThread,
                            providerTurn,
                            `The operator updated task ${run.taskId} while you were working (change ${edit.id}). Read its current title, description, completion criteria and latest progress now. Adapt this ongoing work to the update; preserve completed work and do not restart from scratch. The update does not grant new external permissions.`
                        );
                    } catch (error) {
                        steeringFailed = true;
                        throw error;
                    }
                    if (!accepted) return;
                    if (!(await acknowledgeTaskSteering(client, run, edit.id)))
                        controller.abort();
                }
                if (signal.aborted) return;
                const guidance = await claimChatSteering(client, run);
                if (!guidance) return;
                let accepted: boolean;
                try {
                    accepted = await runtime.steer(
                        providerThread,
                        providerTurn,
                        `New message from the operator while you were working (message ${guidance.id}). Adapt the current work to this message and preserve completed work:\n\n${guidance.content}`
                    );
                } catch (error) {
                    steeringFailed = true;
                    throw error;
                }
                if (accepted) assistanceFinished = false;
                if (!(await acknowledgeChatSteering(client, run, guidance.id, accepted)))
                    controller.abort();
                return;
            })
            .catch(() => controller.abort())
            .finally(() => {
                renewing = false;
            });
    }, 5000);
    const flush = setInterval(() => {
        if (
            updating ||
            (persisted === text && savedActivity === JSON.stringify(activity))
        )
            return;
        updating = true;
        const snapshot = text;
        const currentActivity = activity;
        update = Promise.all([
            saveMiraDelta(client, run, snapshot, [...parts]),
            saveMiraActivity(client, run, currentActivity),
        ])
            .then(([textAccepted, activityAccepted]) => {
                if (textAccepted && activityAccepted) {
                    persisted = snapshot;
                    savedActivity = JSON.stringify(currentActivity);
                } else controller.abort();
                return;
            })
            .catch(() => controller.abort())
            .finally(() => {
                updating = false;
            });
    }, 250);
    try {
        signal.throwIfAborted();
        let record = await readMiraTurnInput(client, run, false, false);
        const automaticModel =
            isSyntheticModel(config.model) && synthetic?.owner !== run.owner
                ? null
                : config.model;
        const useSynthetic = isSyntheticModel(record.settings.model ?? automaticModel);
        if (useSynthetic && (!synthetic || synthetic.owner !== run.owner))
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Synthetic is not connected for this account."
            );
        runtime = useSynthetic
            ? new SyntheticRuntime(synthetic!, run.owner)
            : await CodexRuntime.connect({
                  command: config.command,
                  args: pilotArguments(),
                  cwd: config.workspace,
                  env: runtimeEnvironment(config),
                  signal: transport.signal,
              });
        if (runtime instanceof CodexRuntime) {
            const account = await runtime.account();
            if (!account.authenticated)
                throw new Error("Runtime authentication unavailable.");
        }
        const models =
            runtime instanceof CodexRuntime
                ? await runtime.models()
                : await loadSyntheticModels(synthetic!, signal);
        const settings = resolveMiraChatSettings(models, record.settings, automaticModel);
        const selectedModel = models.find((entry) => entry.model === settings.model)!;
        assistance = liveAssistanceMinutes(record.settings, run) > 0;
        if (assistance && !selectedModel.inputModalities.includes("image"))
            throw new MiraFailure(
                "BAD_REQUEST",
                "Live computer assistance needs a model that supports images."
            );
        const recall = await readMiraRecallPolicy(client, run);
        const recallHash =
            recall.memory && recall.history
                ? miraInstructionsHash
                : new Bun.CryptoHasher("sha256")
                      .update(miraInstructionsHash)
                      .update(JSON.stringify(recall))
                      .digest("hex");
        const executionPolicyHash =
            run.executionTarget === "main"
                ? new Bun.CryptoHasher("sha256")
                      .update(`${recallHash}:code:main`)
                      .digest("hex")
                : recallHash;
        const permissionMode = await miraRunPermission(client, {
            client,
            owner: run.owner,
            actor: `mira:${run.id}`,
            run: { id: run.id, leaseToken: run.leaseToken },
        });
        const turnInstructions =
            permissionMode === "ask"
                ? instructions
                : `${instructions}\nCurrent Chat permission mode: ${permissionMode}. This setting authorizes only the action classes described above for the operator's requested work.`;
        const policyHash =
            permissionMode === "ask"
                ? executionPolicyHash
                : new Bun.CryptoHasher("sha256")
                      .update(`${executionPolicyHash}:permissions:${permissionMode}`)
                      .digest("hex");

        record = await readMiraTurnInput(
            client,
            run,
            useSynthetic,
            selectedModel.inputModalities.includes("image")
        );
        if (useSynthetic) {
            // Keep native history for cleanup, but force product recovery if the user returns to ChatGPT.
            const cleared = await client<
                { id: string }[]
            >`UPDATE mira_conversations SET provider_context_ready=false WHERE id=${run.conversationId} AND owner=${run.owner} AND EXISTS (SELECT 1 FROM mira_runs WHERE id=${run.id} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp()) RETURNING id`;
            if (!cleared[0]) throw new Error("Run lease lost during provider selection.");
        }
        if (
            runtime instanceof CodexRuntime &&
            record.providerThread &&
            record.providerPolicyHash !== policyHash
        ) {
            // Native cold resume can retain old instructions. Rebuild product context instead.
            signal.throwIfAborted();
            await runtime.deleteThread(record.providerThread);
            const cleared = await client<
                { id: string }[]
            >`UPDATE mira_conversations SET provider_thread=NULL,provider_policy_hash=NULL,provider_context_ready=false WHERE id=${run.conversationId} AND owner=${run.owner} AND provider_thread=${record.providerThread} AND EXISTS (SELECT 1 FROM mira_runs WHERE id=${run.id} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp()) RETURNING id`;
            if (!cleared[0]) throw new Error("Run lease lost during policy renewal.");
            record = await readMiraTurnInput(
                client,
                run,
                false,
                selectedModel.inputModalities.includes("image")
            );
        }
        const tools = createMiraToolRouter(
            [
                ...createMiraTools(
                    client,
                    run,
                    filesDirectory,
                    agentMail,
                    moltbook,
                    hereNow,
                    daytona,
                    github,
                    localCode
                ),
                ...(assistance
                    ? [
                          {
                              name: "mira_live_assistance_finish",
                              description:
                                  "End this live computer assistance after your current reply when the operator asks you to stop or their coaching task has ended. This only stops continued work; it does not change local computer consent.",
                              inputSchema: {
                                  type: "object",
                                  properties: {},
                                  additionalProperties: false,
                              },
                              execute: (input: unknown, signal: AbortSignal) => {
                                  signal.throwIfAborted();
                                  v.parse(v.strictObject({}), input);
                                  assistanceFinished = true;
                                  return Promise.resolve(
                                      "Live assistance will finish after this reply."
                                  );
                              },
                          },
                      ]
                    : []),
            ].filter(
                (tool) =>
                    (recall.memory || !tool.name.startsWith("mira_memory_")) &&
                    (recall.history || tool.name !== "mira_history_search") &&
                    (recall.conversation ||
                        (tool.name !== "mira_conversation_history" &&
                            tool.name !== "mira_history_read")) &&
                    (selectedModel.inputModalities.includes("image") ||
                        (!tool.name.startsWith("mira_computer_") &&
                            !tool.name.startsWith("mira_browser_")))
            ),
            !useSynthetic && record.providerThread !== null
        );
        let threadId = useSynthetic ? null : record.providerThread;
        if (threadId && runtime instanceof CodexRuntime) {
            try {
                await runtime.resumeThread(threadId, tools, turnInstructions);
            } catch (error) {
                if (!(error instanceof RuntimeResponseError) || !error.threadMissing)
                    throw error;
                const cleared = await client<
                    { id: string }[]
                >`UPDATE mira_conversations SET provider_thread=NULL,provider_policy_hash=NULL,provider_context_ready=false WHERE id=${run.conversationId} AND owner=${run.owner} AND provider_thread=${threadId} AND EXISTS (SELECT 1 FROM mira_runs WHERE id=${run.id} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp()) RETURNING id`;
                if (!cleared[0])
                    throw new Error("Run lease lost during conversation recovery.", {
                        cause: error,
                    });
                record = await readMiraTurnInput(
                    client,
                    run,
                    false,
                    selectedModel.inputModalities.includes("image")
                );
                threadId = null;
            }
        }
        attachments = await prepareMiraAttachments(
            { client, owner: run.owner, actor: `mira:${run.id}` },
            {
                directory: filesDirectory,
                home: config.codexHome,
                ids: record.attachmentIds,
                signal,
            }
        );
        if (
            attachments.inputs.some((input) => input.type === "localImage") &&
            !selectedModel.inputModalities.includes("image")
        )
            throw new MiraFailure(
                "BAD_REQUEST",
                "The selected model does not support images. Choose another model in Chat settings."
            );
        if (!threadId) {
            const model = settings.model;
            threadId = await runtime.startThread(
                model,
                config.workspace,
                tools,
                turnInstructions
            );
            const stored = useSynthetic
                ? [{ id: run.conversationId }]
                : await client<
                      { id: string }[]
                  >`UPDATE mira_conversations SET provider_thread = ${threadId}, provider_policy_hash = ${policyHash}, provider_context_ready = false, model = ${model} WHERE id = ${run.conversationId} AND EXISTS (SELECT 1 FROM mira_runs WHERE id = ${run.id} AND state = 'running' AND lease_token = ${run.leaseToken} AND lease_expires_at > now()) RETURNING id`;
            if (!stored[0]) throw new Error("Run lease lost.");
        }
        const recorded = await client<
            { id: string }[]
        >`UPDATE mira_runs SET effective_settings = ${JSON.stringify(settings)}::text::jsonb WHERE id = ${run.id} AND state = 'running' AND NOT cancel_requested AND lease_token = ${run.leaseToken} AND lease_expires_at > now() RETURNING id`;
        if (!recorded[0]) throw new Error("Run lease lost.");
        providerThread = threadId;
        const recallContext = await readMiraRecallContext(client, run);
        const initialPrompt = `${recallContext}\n\n${record.content}`;
        const assistanceInstruction =
            "Live computer assistance is enabled by the operator. Inspect fresh screen observations and help with their current request. The host will continue after your replies while access remains active. Give concise advice when useful; do not repeat unchanged advice or invent unseen screen activity. Use mira_live_assistance_finish when the operator asks you to stop or the task ends. All existing permissions still apply.";
        let nextPrompt =
            initialPrompt + (assistance ? `\n\n${assistanceInstruction}` : "");
        let continuation = false;
        let result: Awaited<ReturnType<CodexRuntime["turn"]>>;
        for (;;) {
            if (continuation && runtime instanceof SyntheticRuntime) {
                // Synthetic clears its ephemeral registry after every reply.
                threadId = await runtime.startThread(
                    settings.model,
                    config.workspace,
                    tools,
                    turnInstructions
                );
                providerThread = threadId;
            }
            const guidance = continuation ? await claimChatSteering(client, run) : null;
            let firstDelta = true;
            assistanceIdle = false;
            result = await runtime.turn(
                threadId,
                nextPrompt +
                    (guidance ? `\n\nNew operator message:\n${guidance.content}` : ""),
                {
                    signal,
                    settings,
                    attachments: !continuation || useSynthetic ? attachments.inputs : [],
                    timeoutMs: Math.max(
                        1,
                        Math.min(
                            assistance ? 300_000 : Number.POSITIVE_INFINITY,
                            deadlineAt - Date.now()
                        )
                    ),
                    onStarted: async (turnId) => {
                        await client.begin(async (query) => {
                            const accepted = await query<
                                { id: string }[]
                            >`UPDATE mira_runs SET provider_turn=${turnId} WHERE id=${run.id} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp() RETURNING id`;
                            if (!accepted[0]) {
                                assistanceIdle = assistance;
                                controller.abort();
                                throw new Error(
                                    "Run lease lost before turn acknowledgement."
                                );
                            }
                            if (!useSynthetic)
                                await query`UPDATE mira_conversations SET provider_context_ready=true WHERE id=${run.conversationId} AND provider_thread=${threadId}`;
                        });
                        if (
                            guidance &&
                            !(await acknowledgeChatSteering(
                                client,
                                run,
                                guidance.id,
                                true
                            ))
                        )
                            throw new Error(
                                "Guidance acknowledgement lost its run lease."
                            );
                        providerTurn = turnId;
                    },
                    onActivity: (next) => {
                        activity = next;
                    },
                    onDelta: (delta, itemId) => {
                        const separator =
                            firstDelta && continuation && text ? "\n\n" : "";
                        if (
                            assistance &&
                            text.length + separator.length + delta.length > 256_000
                        ) {
                            replyLimitFailure = new MiraFailure(
                                "PRECONDITION_FAILED",
                                "Live assistance reached its reply limit. Review the conversation before continuing."
                            );
                            throw replyLimitFailure;
                        }
                        text += separator;
                        if (
                            firstDelta ||
                            parts.length === 0 ||
                            (itemId && itemId !== messageId)
                        ) {
                            if (parts.length >= (assistance ? 1024 : 256))
                                throw new Error("Mira reply limit reached.");
                            parts.push({
                                id: Bun.randomUUIDv7(),
                                offset:
                                    // oxlint-disable-next-line typescript/no-misused-spread -- Match PostgreSQL Unicode code point offsets.
                                    [...text].length +
                                    (text && delta.startsWith("\n\n") ? 2 : 0),
                                createdAt: new Date().toISOString(),
                            });
                            messageId = itemId;
                        }
                        text += delta;
                        firstDelta = false;
                    },
                }
            );
            providerTurn = undefined;
            await renewal;
            if (steeringFailed)
                throw new Error("Message delivery could not be confirmed.");
            if (!assistance || assistanceFinished || result.status !== "completed") break;
            assistanceIdle = true;
            activity = { phase: "working", tool: null };
            const pending = await readLiveAssistanceGuidance(client, run);
            if (pending.yieldForAttachments || pending.uncertain) break;
            const access = () =>
                readMiraComputerReadiness({
                    client,
                    owner: run.owner,
                    actor: `mira:${run.id}`,
                    run: { id: run.id, leaseToken: run.leaseToken },
                });
            if (!(await waitForLiveAssistance(access, signal, deadlineAt))) break;
            const updates = await readLiveAssistanceGuidance(client, run);
            if (updates.yieldForAttachments || updates.uncertain) break;
            const reminder =
                "Continue the operator's live computer assistance using a fresh observation. Preserve prior instructions and completed work. Give a new concise reply only when useful. Stop with mira_live_assistance_finish if the operator requested it or the task has ended.";
            nextPrompt = useSynthetic
                ? `${initialPrompt}\n\nAccepted operator guidance for this session:\n${JSON.stringify(updates.guidance)}\n\nRecent replies (historical context):\n${text.slice(-16_000)}\n\n${reminder}`
                : reminder;
            continuation = true;
        }
        clearInterval(interval);
        await renewal;
        if (steeringFailed) throw new Error("Message delivery could not be confirmed.");
        clearInterval(flush);
        await update;
        if (assistanceIdle) {
            const [current] = await client<
                { cancelled: boolean }[]
            >`SELECT cancel_requested AS cancelled FROM mira_runs WHERE id=${run.id} AND owner=${run.owner} AND lease_token=${run.leaseToken}`;
            if (current?.cancelled) result = { ...result, status: "interrupted" };
        }
        await finishMiraRun(client, run, {
            state: result.status,
            text: assistance ? text : result.text,
            parts,
            message:
                result.status === "failed"
                    ? "Mira could not complete the reply. Review the run before continuing."
                    : null,
            providerTurn: result.id,
        });
    } catch (error) {
        clearInterval(flush);
        await update;
        let message =
            "The reply could not be verified. Review this run before continuing; actions were not replayed.";
        if (deadline.signal.aborted)
            message =
                "Maximum run time exceeded during preparation or execution. Review this run before continuing.";
        else if (replyLimitFailure) message = replyLimitFailure.message;
        else if (error instanceof MiraFailure) message = error.message;
        let state: "completed" | "interrupted" | "needs_attention" = "needs_attention";
        if (assistanceIdle) {
            const [current] = await client<
                { cancelled: boolean }[]
            >`SELECT cancel_requested AS cancelled FROM mira_runs WHERE id=${run.id} AND owner=${run.owner} AND lease_token=${run.leaseToken}`;
            if (current?.cancelled) state = "interrupted";
            else if (deadline.signal.aborted || stopping.aborted) state = "completed";
        }
        await finishMiraRun(client, run, {
            state,
            text,
            parts,
            message: state === "needs_attention" ? message : null,
        });
    } finally {
        clearTimeout(timer);
        clearTimeout(stopTransportTimer);
        signal.removeEventListener("abort", stopTransport);
        clearInterval(flush);
        clearInterval(interval);
        await Promise.allSettled([update, renewal]);
        await runtime?.close();
        await attachments?.cleanup();
    }
}
