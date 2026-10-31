import path from "node:path";
import { createInterface } from "node:readline";

import {
    disabledRuntimeFeatures,
    enabledRuntimeFeatures,
} from "../runtime/configuration";
import manifest from "../runtime/systemSkills.json";

// Synthetic process fixture. No provider access, account data or network calls.
const mode = process.argv[2] ?? "ok";
let initialized = false;
let notified = false;
let activeTurn = 0;
let policyThreadDeleted = false;
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
                    itemId: `message-${activeTurn}`,
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
        write({
            id: message.id,
            result: {
                codexHome:
                    mode === "wrong-home"
                        ? "/other-profile"
                        : (process.argv[3] ?? process.cwd()),
            },
        });
    } else if (message.method === "initialized") {
        notified = true;
    } else if (!initialized || !notified) {
        write({ id: message.id, error: { code: -32_000, message: "not initialized" } });
    } else if (message.method === "config/read") {
        write({
            id: message.id,
            result: {
                config: {
                    ...(mode.startsWith("override:")
                        ? { [mode.slice("override:".length)]: "untrusted-override" }
                        : {}),
                    ...(mode === "official-endpoints"
                        ? {
                              openai_base_url: "https://api.openai.com/v1",
                              chatgpt_base_url: "https://chatgpt.com/backend-api/",
                          }
                        : {}),

                    features: Object.fromEntries([
                        ...enabledRuntimeFeatures.map(
                            (feature) =>
                                [feature, mode !== `required-feature:${feature}`] as const
                        ),
                        ...disabledRuntimeFeatures.map(
                            (feature) => [feature, mode === `feature:${feature}`] as const
                        ),
                    ]),
                    web_search: mode === "web-search" ? "live" : "disabled",
                    cli_auth_credentials_store: mode === "keyring" ? "keyring" : "file",
                    model_provider: mode === "configured-provider" ? "custom" : "openai",
                    model_providers:
                        mode === "custom-endpoint"
                            ? { openai: { base_url: "https://example.test" } }
                            : {},
                    project_doc_max_bytes: mode === "project-docs" ? 32_768 : 0,
                    mcp_servers:
                        mode === "configured-mcp"
                            ? { external: { command: "/bin/false", enabled: false } }
                            : {},
                },
            },
        });
    } else if (message.method === "skills/list") {
        const skills = Object.keys(manifest.entries)
            .filter((file) => file.endsWith("/SKILL.md"))
            .map((file) => ({
                name: file.split("/")[0],
                path: path.join(
                    process.argv[3] ?? process.cwd(),
                    "skills",
                    ".system",
                    file
                ),
                scope: "system",
                enabled: true,
                pluginId: null,
            }));
        if (mode === "admin-skill" || mode === "disabled-admin-skill")
            skills.push({
                name: "admin-extra",
                path: "/etc/codex/skills/extra/SKILL.md",
                scope: "admin",
                enabled: mode !== "disabled-admin-skill",
                pluginId: null,
            });
        if (mode === "outside-system-skill")
            skills[0]!.path = "/etc/codex/skills/extra/SKILL.md";
        if (mode === "duplicate-skill") skills[0] = skills[1]!;
        if (mode === "missing-skill") skills.pop();
        write({
            id: message.id,
            result: {
                data: [
                    {
                        cwd: process.cwd(),
                        skills,
                        errors:
                            mode === "skill-discovery-error"
                                ? [
                                      {
                                          path: "/etc/codex/skills",
                                          message: "Cannot inspect",
                                      },
                                  ]
                                : [],
                    },
                ],
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
        if (
            mode === "policy-rotation" &&
            (message.method === "thread/resume" || !policyThreadDeleted)
        ) {
            write({
                id: message.id,
                error: {
                    code: -32_600,
                    message: "Stale policy must be retired before creating a new thread.",
                },
            });
            continue;
        }
        if (message.method === "thread/resume" && mode.startsWith("resume-missing")) {
            write({
                id: message.id,
                error: {
                    code: -32_600,
                    message: `no rollout found for thread id ${mode === "resume-missing-other" ? "another-thread" : String(message.params.threadId)}`,
                },
            });
            continue;
        }
        write({
            id: message.id,
            result: {
                thread: { id: "thread-test" },
                cwd:
                    mode ===
                    `${message.method === "thread/start" ? "thread" : "resume"}-cwd`
                        ? "/unexpected"
                        : process.cwd(),
                instructionSources:
                    mode ===
                    `${message.method === "thread/start" ? "thread" : "resume"}-instructions`
                        ? ["/late/AGENTS.md"]
                        : [],
                approvalPolicy:
                    mode ===
                    `${message.method === "thread/start" ? "thread" : "resume"}-approval`
                        ? "never"
                        : "untrusted",
                sandbox: {
                    type:
                        mode ===
                        `${message.method === "thread/start" ? "thread" : "resume"}-sandbox`
                            ? "dangerFullAccess"
                            : "readOnly",
                    networkAccess:
                        mode ===
                        `${message.method === "thread/start" ? "thread" : "resume"}-network`,
                },
                modelProvider:
                    mode === "thread-provider" ||
                    (mode === "resume-provider" && message.method === "thread/resume")
                        ? "custom"
                        : "openai",
            },
        });
    } else if (message.method === "thread/delete") {
        policyThreadDeleted = true;
        if (mode === "delete-missing")
            write({
                id: message.id,
                error: {
                    code: -32_600,
                    message: `thread not found: ${String(message.params.threadId)}`,
                },
            });
        else if (mode === "delete-other-error")
            write({
                id: message.id,
                error: { code: -32_600, message: "thread not found: another-thread" },
            });
        else write({ id: message.id, result: {} });
    } else if (message.method === "turn/start") {
        activeTurn++;
        const turnId = `turn-${activeTurn}`;
        if (mode.startsWith("message-")) {
            write({ id: message.id, result: { turn: { id: turnId } } });
            await Bun.sleep(20);
            const emit = (itemId: string, delta: string, scope = {}) =>
                write({
                    method: "item/agentMessage/delta",
                    params: { threadId: "thread-test", turnId, itemId, delta, ...scope },
                });
            if (mode === "message-boundaries") {
                emit("empty-first", "");
                emit("commentary", "Creating ");
                emit("commentary", "the file.");
                emit("empty-middle", "");
                emit("foreign", "unrelated", { threadId: "other-thread" });
                emit("foreign", "stale", { turnId: "other-turn" });
                emit("final", "Created.\n\n```json\n{");
                emit("final", '\n  "ok": true\n}\n```');
            } else {
                emit("first", "x".repeat(255_999));
                emit(mode === "message-limit-same-item" ? "first" : "second", "y");
            }
            write({
                method: "turn/completed",
                params: {
                    threadId: "thread-test",
                    turn: { id: turnId, status: "completed" },
                },
            });
            continue;
        }
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
                    tool:
                        (
                            {
                                "tool-unknown": "administer_host",
                                "tool-router": "mira_tool_call",
                            } as Record<string, string>
                        )[mode] ?? "echo",
                    arguments:
                        mode === "tool-router"
                            ? { name: "echo", arguments: { marker: "test" } }
                            : { marker: "test" },
                },
            });
            continue;
        }
        if (mode === "settings-activity") {
            write({
                method: "item/started",
                params: {
                    threadId: "unrelated-thread",
                    turnId,
                    item: { type: "reasoning" },
                },
            });
            write({
                method: "item/started",
                params: { threadId: "thread-test", turnId, item: { type: "reasoning" } },
            });
        }
        let text = mode === "failed" ? "" : "Synthetic response";
        if (mode === "resume-missing" || mode === "policy-rotation")
            text = JSON.stringify(message.params.input);
        if (mode === "settings-activity")
            text = JSON.stringify({
                model: message.params.model,
                effort: message.params.effort,
                serviceTier: message.params.serviceTier,
            });
        if (mode !== "wait" && !mode.startsWith("steer-")) {
            write({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "thread-test",
                    turnId,
                    itemId: `message-${activeTurn}`,
                    delta: text,
                },
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
    } else if (message.method === "turn/steer") {
        if (mode === "steer-error") {
            write({
                id: message.id,
                error: { code: -32_000, message: "synthetic steering failure" },
            });
            continue;
        }
        if (
            message.params.threadId !== "thread-test" ||
            message.params.expectedTurnId !== `turn-${activeTurn}`
        )
            throw new Error("Unexpected steering identity.");
        write({
            id: message.id,
            result: {
                turnId:
                    mode === "steer-wrong-receipt" ? "other-turn" : `turn-${activeTurn}`,
            },
        });
        if (mode === "steer-ok") {
            write({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "thread-test",
                    turnId: `turn-${activeTurn}`,
                    itemId: "steered-result",
                    delta: JSON.stringify(message.params.input),
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
