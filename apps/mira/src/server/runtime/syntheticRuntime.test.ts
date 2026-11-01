import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as v from "valibot";

import { createVisualChallenge } from "../testing/visualChallenge";
import { syntheticModels } from "./syntheticCatalog";
import { syntheticConfiguration } from "./syntheticConfiguration";
import { loadSyntheticModels, SyntheticRuntime } from "./syntheticRuntime";
import { syntheticEvents } from "./syntheticStream";

const configuration = { owner: "operator", apiKey: "synthetic-fixture-secret-only" };
const settings = { model: "syn:large:text", effort: "high", serviceTier: null };
const signal = new AbortController().signal;
const model = {
    id: settings.model,
    always_on: true,
    alias_of: "Current target",
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_features: ["tools", "reasoning"],
    reasoning_parameters: { efforts: ["low", "high"] },
};
const chunk = (delta: object, finish: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (events: unknown[], done = true) =>
    new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") +
            (done ? "data: [DONE]\r\n\r\n" : ""),
        { headers: { "content-type": "text/event-stream" } }
    );
const transport = (
    callback: (url: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch =>
    Object.assign(
        (input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(
                (input instanceof Request ? input.url : input.toString()).endsWith(
                    "/v2/quotas"
                )
                    ? Response.json({ subscription: { limit: 100, requests: 0 } })
                    : callback(
                          input instanceof Request ? input.url : input.toString(),
                          init ?? {}
                      )
            ),
        { preconnect: fetch.preconnect }
    );

test("Synthetic keeps aliases while their current target and capabilities change", () => {
    const original = syntheticModels({ data: [model] });
    const changed = syntheticModels({
        data: [
            {
                ...model,
                alias_of: "New target",
                input_modalities: ["text"],
                reasoning_parameters: { efforts: ["max"] },
            },
        ],
    });
    expect(original[0]?.model).toBe(settings.model);
    expect(changed[0]?.model).toBe(settings.model);
    expect(changed[0]?.description).toContain("New target");
    expect(changed[0]?.inputModalities).toEqual(["text"]);
    expect(changed[0]?.supportedReasoningEfforts[0]?.reasoningEffort).toBe("max");
    expect(syntheticModels({ data: [{ ...model, supported_features: [] }] })).toEqual([]);
    expect(syntheticModels({ data: [{ ...model, always_on: false }] })).toEqual([]);
    expect(
        syntheticModels({ data: [{ ...model, id: "hf:provider/paid-model" }] })
    ).toEqual([]);
    expect(() => syntheticModels({ data: [model, model] })).toThrow("duplicate");
});

test("Synthetic catalog authenticates its owner-bound credential only at the fixed origin", async () => {
    expect(syntheticConfiguration({})).toBeUndefined();
    expect(() =>
        syntheticConfiguration({ HOMELAB_MIRA_SYNTHETIC_API_KEY: configuration.apiKey })
    ).toThrow("owner");
    expect(() => new SyntheticRuntime(configuration, "someone-else")).toThrow("account");
    const models = await loadSyntheticModels(
        configuration,
        signal,
        transport((url, init) => {
            expect(url).toBe("https://api.synthetic.new/openai/v1/models");
            expect(new Headers(init.headers).get("authorization")).toBe(
                `Bearer ${configuration.apiKey}`
            );
            expect(init.redirect).toBe("error");
            return Response.json({ data: [model] });
        })
    );
    expect(models[0]?.model).toBe(settings.model);
});

test("Synthetic stream reconstructs split UTF-8 and rejects an unterminated response", async () => {
    const bytes = new TextEncoder().encode(
        ': comment\r\ndata: {"text":"æøå"}\r\n\r\ndata: [DONE]\r\n\r\n'
    );
    const response = new Response(
        new ReadableStream({
            start(controller) {
                for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                controller.close();
            },
        }),
        { headers: { "content-type": "text/event-stream" } }
    );
    const events = [];
    for await (const event of syntheticEvents(response, signal)) events.push(event);
    expect(events).toEqual([{ text: "æøå" }]);
    const incompleteResponse = stream([{}], false);
    const incomplete = async () => {
        for await (const _event of syntheticEvents(incompleteResponse, signal)) {
            /* Consume until the transport detects the missing terminator. */
        }
    };
    await rejects(incomplete(), /disconnected/);
});

test("Synthetic uses the selected alias, streams text and calls only acknowledged registered tools", async () => {
    const bodies: Record<string, unknown>[] = [];
    const calls: unknown[] = [];
    let acknowledged = false;
    const runtime = new SyntheticRuntime(
        configuration,
        "operator",
        transport((url, init) => {
            expect(url).toBe("https://api.synthetic.new/openai/v1/chat/completions");
            expect(init.redirect).toBe("error");
            expect(new Headers(init.headers).get("authorization")).toBe(
                `Bearer ${configuration.apiKey}`
            );
            const body = JSON.parse(v.parse(v.string(), init.body)) as Record<
                string,
                unknown
            >;
            bodies.push(body);
            expect(body.model).toBe(settings.model);
            expect(body.reasoning_effort).toBe("high");
            return bodies.length === 1
                ? stream([
                      chunk({ content: "Checking." }),
                      chunk({
                          tool_calls: [
                              {
                                  index: 0,
                                  id: "call-1",
                                  type: "function",
                                  function: { name: "read_task", arguments: '{"id":' },
                              },
                          ],
                      }),
                      chunk(
                          {
                              tool_calls: [
                                  { index: 0, function: { arguments: '"fixture"}' } },
                              ],
                          },
                          "tool_calls"
                      ),
                  ])
                : stream([chunk({ content: "Done." }, "stop")]);
        })
    );
    const thread = await runtime.startThread(
        settings.model,
        "/unused",
        [
            {
                name: "read_task",
                description: "Read owned task",
                inputSchema: { type: "object" },
                execute: (input, _signal, call) => {
                    expect(acknowledged).toBe(true);
                    expect(call.threadId).toBe(thread);
                    calls.push(input);
                    return Promise.resolve("Fixture receipt");
                },
            },
        ],
        "Trusted fixture policy"
    );
    let streamed = "";
    const result = await runtime.turn(thread, "Read fixture", {
        settings,
        onStarted: () => {
            acknowledged = true;
            return Promise.resolve();
        },
        onDelta: (delta) => {
            streamed += delta;
        },
    });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Checking.\n\nDone.");
    expect(streamed).toBe(result.text);
    expect(calls).toEqual([{ id: "fixture" }]);
    expect(JSON.stringify(bodies[1])).toContain("Fixture receipt");
    expect(JSON.stringify(bodies)).not.toContain(configuration.apiKey);
    await runtime.close();
});

test.each(["", "\n", "\r\n"])(
    "Synthetic accepts an explicit final marker at EOF (%s) and nullable tool fragments",
    async (ending) => {
        let requests = 0;
        let executed = 0;
        const runtime = new SyntheticRuntime(
            configuration,
            "operator",
            transport((_url, init) => {
                requests++;
                if (requests === 2) {
                    expect(v.parse(v.string(), init.body)).toContain(
                        "private test reasoning"
                    );
                    return new Response(
                        `data: ${JSON.stringify(chunk({ content: "Verified" }, "stop"))}\n\ndata: {"choices":[]}\n\ndata: [DONE]${ending}`,
                        { headers: { "content-type": "text/event-stream" } }
                    );
                }
                return new Response(
                    [
                        chunk({ reasoning: "private test reasoning" }),
                        chunk({
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "fixture-call",
                                    type: "function",
                                    function: { name: "fixture_echo", arguments: "" },
                                },
                            ],
                        }),
                        chunk(
                            {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: null,
                                        type: null,
                                        function: { name: null, arguments: "{}" },
                                    },
                                ],
                            },
                            "tool_calls"
                        ),
                    ]
                        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                        .join("") + `data: [DONE]${ending}`,
                    { headers: { "content-type": "text/event-stream" } }
                );
            })
        );
        try {
            const thread = await runtime.startThread(
                settings.model,
                "/unused",
                [
                    {
                        name: "fixture_echo",
                        description: "Test receipt",
                        inputSchema: { type: "object" },
                        execute: () => {
                            executed++;
                            return Promise.resolve("Receipt");
                        },
                    },
                ],
                "Fixture"
            );
            const result = await runtime.turn(thread, "Run fixture", { settings });
            expect(result.status).toBe("completed");
            expect(result.text).toBe("Verified");
            expect(executed).toBe(1);
        } finally {
            await runtime.close();
        }
    }
);

test.each(["data: [DON", "data: [DONE]truncated", 'data: {"choices":[]}\n'])(
    "Synthetic rejects an incomplete stream terminator (%s)",
    async (tail) => {
        const consume = async () => {
            const response = new Response(tail, {
                headers: { "content-type": "text/event-stream" },
            });
            for await (const _event of syntheticEvents(response, signal)) {
                /* Consume the incomplete fixture. */
            }
        };
        await rejects(consume(), /disconnected/);
    }
);

test.each(["disconnect", "length", "duplicate", "unregistered", "tool_failure"])(
    "Synthetic refuses %s without replaying side effects",
    async (mode) => {
        let requests = 0,
            executed = 0;
        const runtime = new SyntheticRuntime(
            configuration,
            "operator",
            transport(() => {
                requests++;
                if (mode === "disconnect")
                    return stream([chunk({ content: "Partial" }, "stop")], false);
                if (mode === "length")
                    return stream([chunk({ content: "Partial" }, "length")]);
                return stream([
                    chunk(
                        {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "same-call",
                                    type: "function",
                                    function: {
                                        name:
                                            mode === "unregistered" ? "unknown" : "write",
                                        arguments: "{}",
                                    },
                                },
                            ],
                        },
                        "tool_calls"
                    ),
                ]);
            })
        );
        const thread = await runtime.startThread(
            settings.model,
            "/unused",
            [
                {
                    name: "write",
                    description: "Fixture mutation",
                    inputSchema: {},
                    execute: () => {
                        executed++;
                        if (mode === "tool_failure")
                            return Promise.reject(new Error("Unknown outcome"));
                        return Promise.resolve("receipt");
                    },
                },
            ],
            "Fixture"
        );
        await rejects(runtime.turn(thread, "Fixture", { settings }));
        expect(requests).toBe(mode === "duplicate" ? 2 : 1);
        expect(executed).toBe(mode === "duplicate" || mode === "tool_failure" ? 1 : 0);
        await runtime.close();
    }
);

test("Synthetic steering prevents queued stale tools and continues with the operator update", async () => {
    let requests = 0,
        executions = 0,
        turnId = "";
    const runtime = new SyntheticRuntime(
        configuration,
        "operator",
        transport(async (_url, init) => {
            requests++;
            if (requests === 1) {
                expect(
                    await runtime.steer(thread, turnId, "Read the changed task first.")
                ).toBe(true);
                return stream([
                    chunk(
                        {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "stale",
                                    type: "function",
                                    function: { name: "write", arguments: "{}" },
                                },
                            ],
                        },
                        "tool_calls"
                    ),
                ]);
            }
            expect(v.parse(v.string(), init.body)).toContain(
                "Read the changed task first."
            );
            expect(v.parse(v.string(), init.body)).toContain("Not executed");
            return stream([chunk({ content: "Adjusted to the new task." }, "stop")]);
        })
    );
    const thread = await runtime.startThread(
        settings.model,
        "/unused",
        [
            {
                name: "write",
                description: "Fixture",
                inputSchema: {},
                execute: () => {
                    executions++;
                    return Promise.resolve("ok");
                },
            },
        ],
        "Fixture"
    );
    const result = await runtime.turn(thread, "Old task", {
        settings,
        onStarted: (id) => {
            turnId = id;
            return Promise.resolve();
        },
    });
    expect(result.status).toBe("completed");
    expect(executions).toBe(0);
    expect(await runtime.steer(thread, turnId, "Too late")).toBe(false);
    await runtime.close();
});

test("Synthetic cancellation stops a stalled response without invoking a tool", async () => {
    const abort = new AbortController();
    let requested = false;
    const runtime = new SyntheticRuntime(
        configuration,
        "operator",
        transport((_url, init) => {
            requested = true;
            return new Promise((_resolve, reject) => {
                init.signal!.addEventListener(
                    "abort",
                    () => reject(new Error("aborted")),
                    { once: true }
                );
            });
        })
    );
    const thread = await runtime.startThread(settings.model, "/unused", [], "Fixture");
    const pending = runtime.turn(thread, "Fixture", { settings, signal: abort.signal });
    while (!requested) await Bun.sleep(1);
    abort.abort();
    const result = await pending;
    expect(result.status).toBe("interrupted");
    await runtime.close();
});

test.each([
    "exhausted",
    "fractional",
    "weekly-exhausted",
    "weekly-malformed",
    "rejected",
    "malformed",
])("Synthetic refuses %s subscription allowance before inference", async (mode) => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const request: typeof fetch = Object.assign(
        (input: string | URL | Request, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input.toString();
            requests.push({ url, init });
            if (url.endsWith("/chat/completions"))
                return Promise.resolve(
                    stream([chunk({ content: "Unexpected inference" }, "stop")])
                );
            const quota: Record<string, unknown> = {
                subscription: { limit: 100, requests: 0 },
            };
            if (mode === "exhausted") quota.subscription = { limit: 100, requests: 100 };
            if (mode === "fractional")
                quota.subscription = { limit: 100, requests: 99.5 };
            if (mode === "malformed") quota.subscription = { limit: "100", requests: 0 };
            if (mode === "weekly-exhausted")
                quota.planWeeklyLimit = { percentRemaining: 0 };
            if (mode === "weekly-malformed")
                quota.planWeeklyLimit = { percentRemaining: "100" };
            return Promise.resolve(
                mode === "rejected"
                    ? new Response(null, { status: 401 })
                    : Response.json(quota)
            );
        },
        { preconnect: fetch.preconnect }
    );
    const runtime = new SyntheticRuntime(configuration, "operator", request);
    try {
        const thread = await runtime.startThread(
            settings.model,
            "/unused",
            [],
            "Fixture"
        );
        await rejects(runtime.turn(thread, "Fixture", { settings }));
        expect(requests.map((entry) => entry.url)).toEqual([
            "https://api.synthetic.new/v2/quotas",
        ]);
        expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
            `Bearer ${configuration.apiKey}`
        );
        expect(requests[0]?.init?.redirect).toBe("error");
    } finally {
        await runtime.close();
    }
});

test("Synthetic serializes quota and stream consumption across runs and releases an aborted waiter", async () => {
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let quotaReads = 0;
    let posts = 0;
    const request: typeof fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input.toString();
            if (url.endsWith("/v2/quotas")) {
                quotaReads++;
                return Response.json({
                    subscription: { limit: 1, requests: posts },
                    planWeeklyLimit: { percentRemaining: 100 },
                });
            }
            posts++;
            const body = JSON.parse(v.parse(v.string(), init?.body)) as Record<
                string,
                unknown
            >;
            expect(body.tools).toBeUndefined();
            expect(body.parallel_tool_calls).toBeUndefined();
            started.resolve();
            await finished.promise;
            return stream([chunk({ content: "Completed within quota" }, "stop")]);
        },
        { preconnect: fetch.preconnect }
    );
    const runtimes = [0, 1, 2].map(
        () => new SyntheticRuntime(configuration, "operator", request)
    );
    const threads = await Promise.all(
        runtimes.map((runtime) =>
            runtime.startThread(settings.model, "/unused", [], "Fixture")
        )
    );
    try {
        const first = runtimes[0]!.turn(threads[0]!, "Fixture", { settings });
        await started.promise;
        const controller = new AbortController();
        const cancelled = runtimes[1]!.turn(threads[1]!, "Fixture", {
            settings,
            signal: controller.signal,
        });
        controller.abort();
        const cancelledResult = await cancelled;
        expect(cancelledResult.status).toBe("interrupted");
        const last = rejects(
            runtimes[2]!.turn(threads[2]!, "Fixture", { settings }),
            /allowance/
        );
        await Bun.sleep(10);
        expect(quotaReads).toBe(1);
        expect(posts).toBe(1);
        finished.resolve();
        const firstResult = await first;
        expect(firstResult.status).toBe("completed");
        await last;
        expect(quotaReads).toBe(2);
        expect(posts).toBe(1);
    } finally {
        finished.resolve();
        await Promise.all(runtimes.map((runtime) => runtime.close()));
    }
});

test("Synthetic sends selected WebP attachments and keeps all tool replies before screenshot inputs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "synthetic-visual-"));
    const attachment = path.join(directory, "selected-image");
    const webp = Buffer.from(
        "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        "base64"
    );
    await writeFile(attachment, webp);
    const screenshot = createVisualChallenge().data;
    const bodies: Record<string, unknown>[] = [];
    const runtime = new SyntheticRuntime(
        configuration,
        "operator",
        transport((_url, init) => {
            bodies.push(
                v.parse(
                    v.record(v.string(), v.unknown()),
                    JSON.parse(v.parse(v.string(), init.body))
                )
            );
            return bodies.length === 1
                ? stream([
                      chunk(
                          {
                              tool_calls: [0, 1].map((index) => ({
                                  index,
                                  id: `image-${index}`,
                                  type: "function",
                                  function: { name: "observe", arguments: "{}" },
                              })),
                          },
                          "tool_calls"
                      ),
                  ])
                : stream([chunk({ content: "Reviewed both images." }, "stop")]);
        })
    );
    try {
        const thread = await runtime.startThread(
            settings.model,
            "/unused",
            [
                {
                    name: "observe",
                    description: "Read fixture",
                    inputSchema: {},
                    execute: () =>
                        Promise.resolve({
                            content: [
                                {
                                    type: "image" as const,
                                    mediaType: "image/png" as const,
                                    data: screenshot,
                                },
                            ],
                        }),
                },
            ],
            "Fixture"
        );
        const result = await runtime.turn(thread, "Inspect selected file.", {
            settings,
            attachments: [{ type: "localImage", path: attachment }],
        });
        expect(result.status).toBe("completed");
        expect(JSON.stringify(bodies[0])).toContain(
            `data:image/webp;base64,${webp.toString("base64")}`
        );
        const messages = v.parse(
            v.array(
                v.object({
                    role: v.string(),
                    content: v.unknown(),
                    tool_call_id: v.optional(v.string()),
                })
            ),
            bodies[1]?.messages
        );
        expect(messages.map((message) => message.role)).toEqual([
            "system",
            "user",
            "assistant",
            "tool",
            "tool",
            "user",
            "user",
        ]);
        expect(messages.slice(3, 5).map((message) => message.tool_call_id)).toEqual([
            "image-0",
            "image-1",
        ]);
        expect(JSON.stringify(messages[5])).toContain(
            `data:image/png;base64,${screenshot}`
        );
    } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
});
