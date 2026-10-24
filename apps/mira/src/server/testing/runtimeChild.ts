import { createInterface } from "node:readline";

// Synthetic process fixture. No provider access, account data or network calls.
const mode = process.argv[2] ?? "ok";
let initialized = false;
let notified = false;
let activeTurn = 0;
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const reader = createInterface({ input: process.stdin });
for await (const line of reader) {
    const message = JSON.parse(line) as {
        id?: number;
        method: string;
        params: Record<string, unknown>;
        result?: unknown;
        error?: unknown;
    };
    if (!message.method) {
        if (mode.startsWith("tool-") || mode === "approval") {
            write({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "thread-test",
                    turnId: `turn-${activeTurn}`,
                    delta: JSON.stringify(message.result ?? message.error),
                },
            });
            write({
                method: "turn/completed",
                params: {
                    threadId: "thread-test",
                    turn: { id: `turn-${activeTurn}`, status: "completed" },
                },
            });
        }
        continue;
    }
    if (mode === "malformed") {
        process.stdout.write("not json\n");
        continue;
    }
    if (mode === "oversized") {
        process.stdout.write("x".repeat(10_000));
        continue;
    }
    if (mode === "timeout") continue;
    if (mode === "exit") {
        process.stdin.destroy();
        break;
    }
    if (message.method === "initialize") {
        initialized = true;
        write({ id: message.id, result: {} });
    } else if (message.method === "initialized") {
        notified = true;
    } else if (!initialized || !notified) {
        write({ id: message.id, error: { code: -32_000, message: "not initialized" } });
    } else if (message.method === "config/read") {
        write({
            id: message.id,
            result: {
                config: {
                    project_doc_max_bytes: mode === "project-docs" ? 32_768 : 0,
                    mcp_servers:
                        mode === "configured-mcp"
                            ? { external: { command: "/bin/false", enabled: false } }
                            : {},
                },
            },
        });
    } else if (message.method === "account/read") {
        write({
            id: message.id,
            result: {
                account: {
                    type: "chatgpt",
                    planType: "plus",
                    email: "private@example.test",
                },
            },
        });
    } else if (message.method === "model/list") {
        write({
            id: message.id,
            result: { data: [{ model: "synthetic", isDefault: true }], nextCursor: null },
        });
    } else if (message.method === "thread/start" || message.method === "thread/resume") {
        write({ id: message.id, result: { thread: { id: "thread-test" } } });
    } else if (message.method === "turn/start") {
        activeTurn++;
        const turnId = `turn-${activeTurn}`;
        if (mode.startsWith("tool-") || mode === "approval") {
            write({ id: message.id, result: { turn: { id: turnId } } });
            write({
                id: "host-call",
                method:
                    mode === "approval"
                        ? "item/commandExecution/requestApproval"
                        : "item/tool/call",
                params: {
                    threadId:
                        mode === "tool-other-thread" ? "other-thread" : "thread-test",
                    turnId,
                    callId: "call-1",
                    tool: mode === "tool-unknown" ? "administer_host" : "echo",
                    arguments: { marker: "test" },
                },
            });
            continue;
        }
        const text = mode === "failed" ? "" : "Synthetic response";
        if (mode !== "wait") {
            write({
                method: "item/agentMessage/delta",
                params: { threadId: "thread-test", turnId, delta: text },
            });
            write({
                method: "turn/completed",
                params: {
                    threadId: "thread-test",
                    turn: {
                        id: turnId,
                        status: mode === "failed" ? "failed" : "completed",
                    },
                },
            });
        }
        write({ id: message.id, result: { turn: { id: turnId } } });
    } else if (message.method === "turn/interrupt") {
        write({ id: message.id, result: {} });
        write({
            method: "turn/completed",
            params: {
                threadId: "thread-test",
                turn: { id: `turn-${activeTurn}`, status: "interrupted" },
            },
        });
    } else {
        write({
            id: message.id,
            error: { code: -32_001, message: "sensitive provider diagnostic" },
        });
    }
}
