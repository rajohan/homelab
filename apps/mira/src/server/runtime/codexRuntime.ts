import * as v from "valibot";

import { assertRuntimeIsolation } from "./configuration";
import {
    accountSchema,
    completedSchema,
    deltaSchema,
    modelsSchema,
    threadSchema,
    toolCallSchema,
    turnSchema,
    type RuntimeEvent,
    type RuntimeTool,
    type TurnResult,
} from "./protocol";
import { RpcProcess, type RpcProcessOptions } from "./rpcProcess";

interface ActiveTurn {
    threadId: string;
    id: string | null;
    controller: AbortController;
    calls: Set<string>;
    acknowledged: PromiseWithResolvers<string>;
}

/** A single-turn Codex adapter with explicit tools and no implicit approval grants. */
export class CodexRuntime {
    private readonly connection: RpcProcess;
    private readonly threads = new Map<string, RuntimeTool[]>();
    private active: ActiveTurn | null = null;

    private constructor(options: Omit<RpcProcessOptions, "onRequest">) {
        this.connection = new RpcProcess({
            ...options,
            onRequest: (event, signal) => this.handleRequest(event, signal),
        });
    }

    /**
     * Initialize the private runtime handshake before accepting any operations.
     * @param options - Isolated child executable, environment and workspace.
     * @returns An initialized adapter; initialization failure always reaps the child.
     */
    static async connect(
        options: Omit<RpcProcessOptions, "onRequest">
    ): Promise<CodexRuntime> {
        const runtime = new CodexRuntime(options);
        try {
            await runtime.connection.request("initialize", {
                clientInfo: {
                    name: "homelab_mira",
                    title: "Homelab Mira",
                    version: "0.1.0",
                },
                capabilities: { experimentalApi: true },
            });
            runtime.connection.notify("initialized", {});
            assertRuntimeIsolation(
                await runtime.connection.request("config/read", {
                    includeLayers: false,
                    cwd: options.cwd,
                })
            );
            return runtime;
        } catch (error) {
            await runtime.close();
            throw error;
        }
    }

    /**
     * Inspect authentication without exposing account identity or credentials.
     * @returns Whether ChatGPT authentication exists and its reported plan.
     */
    async account(): Promise<{ authenticated: boolean; plan: string | null }> {
        const { account } = v.parse(
            accountSchema,
            await this.connection.request("account/read", { refreshToken: false })
        );
        return {
            authenticated: account?.type === "chatgpt",
            plan: account?.planType ?? null,
        };
    }

    /**
     * List advertised model choices; actual inference must still prove access.
     * @returns The paginated model catalog.
     */
    async models(): Promise<{ model: string; isDefault: boolean }[]> {
        const models: { model: string; isDefault: boolean }[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
            const page: v.InferOutput<typeof modelsSchema> = v.parse(
                modelsSchema,
                await this.connection.request("model/list", { cursor, limit: 100 })
            );
            models.push(...page.data);
            cursor = page.nextCursor;
            if (cursor && (cursors.has(cursor) || cursors.size >= 20))
                throw new Error("Mira model inventory pagination did not terminate.");
            if (cursor) cursors.add(cursor);
        } while (cursor);
        return models;
    }

    /**
     * Create a read-only pilot thread with only caller-registered service tools.
     * @param model - Explicit model identifier selected from the runtime catalog.
     * @param workspace - Empty pilot directory, separate from runtime credentials.
     * @param tools - Trusted host tools; their handlers validate arguments and authority.
     * @returns The provider thread reference, not the product conversation identifier.
     */
    async startThread(
        model: string,
        workspace: string,
        tools: RuntimeTool[]
    ): Promise<string> {
        const result = v.parse(
            threadSchema,
            await this.connection.request("thread/start", {
                model,
                cwd: workspace,
                sandbox: "read-only",
                approvalPolicy: "untrusted",
                developerInstructions:
                    "You are Mira in a synthetic runtime qualification. Use only the supplied qualification tools. Do not inspect files, access websites or use other tools. Do not delegate. Follow the user's synthetic test instructions.",
                dynamicTools: tools.map(({ name, description, inputSchema }) => ({
                    type: "function",
                    name,
                    description,
                    inputSchema,
                })),
            })
        );
        this.threads.set(result.thread.id, tools);
        return result.thread.id;
    }

    /**
     * Reopen a stored provider thread while re-establishing host-side tool authority.
     * @param threadId - Previously recorded provider reference.
     * @param tools - Current trusted registry; stored tool declarations cannot authorize calls.
     * @returns Completion after the runtime has restored the thread.
     */
    async resumeThread(threadId: string, tools: RuntimeTool[]): Promise<void> {
        const result = v.parse(
            threadSchema,
            await this.connection.request("thread/resume", {
                threadId,
                excludeTurns: true,
                sandbox: "read-only",
                approvalPolicy: "untrusted",
            })
        );
        if (result.thread.id !== threadId)
            throw new Error("Mira restored an unexpected thread.");
        this.threads.set(threadId, tools);
    }

    /**
     * Stream one bounded turn and distinguish completion from interruption or failure.
     * @param threadId - Thread established by this adapter.
     * @param text - User input for this turn.
     * @param options - Optional deadline, cancellation and synchronous text observer.
     * @returns The final provider outcome and collected text.
     */
    async turn(
        threadId: string,
        text: string,
        options: {
            signal?: AbortSignal;
            timeoutMs?: number;
            onDelta?: (delta: string) => void;
        } = {}
    ): Promise<TurnResult> {
        if (this.active) throw new Error("Mira already has an active turn.");
        if (!this.threads.has(threadId))
            throw new Error("Mira thread has not been established.");
        options.signal?.throwIfAborted();
        const controller = new AbortController();
        const active: ActiveTurn = {
            threadId,
            id: null,
            controller,
            calls: new Set(),
            acknowledged: Promise.withResolvers<string>(),
        };
        void active.acknowledged.promise.catch(() => {});
        this.active = active;
        let output = "";
        const completion = Promise.withResolvers<TurnResult>();
        // The notification can arrive before the turn/start response.
        const unsubscribe = this.connection.subscribe((event) => {
            if (event.method === "item/agentMessage/delta") {
                const delta = v.parse(deltaSchema, event.params);
                if (
                    delta.threadId !== threadId ||
                    (active.id && delta.turnId !== active.id)
                )
                    return;
                if (output.length + delta.delta.length > 256_000)
                    throw new Error("Mira output limit reached.");
                output += delta.delta;
                options.onDelta?.(delta.delta);
            } else if (event.method === "turn/completed") {
                const result = v.parse(completedSchema, event.params);
                if (
                    result.threadId !== threadId ||
                    (active.id && result.turn.id !== active.id)
                )
                    return;
                if (result.turn.status === "inProgress")
                    throw new Error("Invalid terminal status.");
                completion.resolve({
                    id: result.turn.id,
                    status: result.turn.status,
                    text: output,
                });
            }
        });
        const disconnect = () =>
            completion.reject(
                new Error(
                    "Mira runtime disconnected during the turn; outcome needs reconciliation."
                )
            );
        this.connection.signal.addEventListener("abort", disconnect, { once: true });
        // Attach a rejection handler before any await; disconnect may race turn/start.
        void completion.promise.catch(() => {});
        const abort = () => {
            controller.abort();
            if (active.id)
                void this.interrupt().catch(() => {
                    void this.close();
                });
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        const deadline = setTimeout(() => {
            completion.reject(
                new Error("Mira turn exceeded its deadline; reconcile before retrying.")
            );
            void this.close();
        }, options.timeoutMs ?? 120_000);
        try {
            const started = v.parse(
                turnSchema,
                await this.connection.request("turn/start", {
                    threadId,
                    input: [{ type: "text", text, text_elements: [] }],
                })
            );
            active.id = started.turn.id;
            active.acknowledged.resolve(started.turn.id);
            if (controller.signal.aborted) await this.interrupt();
            const result = await completion.promise;
            if (result.id !== active.id)
                throw new Error("Mira returned an unexpected turn.");
            return result;
        } finally {
            clearTimeout(deadline);
            unsubscribe();
            controller.abort();
            active.acknowledged.reject(new Error("Mira turn did not start."));
            options.signal?.removeEventListener("abort", abort);
            this.connection.signal.removeEventListener("abort", disconnect);
            this.active = null;
        }
    }

    /** Request interruption of the current turn; completion still comes from the runtime. */
    async interrupt(): Promise<void> {
        const active = this.active;
        if (!active?.id) return;
        active.controller.abort();
        await this.connection.request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.id,
        });
    }

    /** Reap the runtime without changing any other Codex or OpenClaw process. */
    async close(): Promise<void> {
        this.active?.controller.abort();
        await this.connection.close();
    }

    private async handleRequest(
        event: RuntimeEvent,
        signal: AbortSignal
    ): Promise<unknown> {
        if (
            event.method === "item/commandExecution/requestApproval" ||
            event.method === "item/fileChange/requestApproval"
        )
            return { decision: "decline" };
        if (event.method === "item/permissions/requestApproval")
            return { permissions: {}, scope: "turn" };
        if (event.method !== "item/tool/call")
            throw new Error("Unsupported runtime request.");
        const call = v.parse(toolCallSchema, event.params);
        const active = this.active;
        if (!active) throw new Error("No active Mira run.");
        const acknowledgedId = await active.acknowledged.promise;
        if (
            !active ||
            active.threadId !== call.threadId ||
            acknowledgedId !== call.turnId ||
            active.calls.has(call.callId) ||
            active.calls.size >= 32
        )
            throw new Error("Tool call does not belong to the active run.");
        const tool = this.threads
            .get(call.threadId)
            ?.find((entry) => entry.name === call.tool);
        if (!tool) throw new Error("Tool is not registered for this run.");
        active.calls.add(call.callId);
        const turnSignal = AbortSignal.any([signal, active.controller.signal]);
        turnSignal.throwIfAborted();
        try {
            const text = await tool.execute(call.arguments, turnSignal);
            turnSignal.throwIfAborted();
            return { success: true, contentItems: [{ type: "inputText", text }] };
        } catch {
            return {
                success: false,
                contentItems: [
                    { type: "inputText", text: "Mira tool did not complete." },
                ],
            };
        }
    }
}
