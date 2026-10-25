import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { version as toolboxVersion } from "@daytona/toolbox-api-client/package.json";

import { daytonaBindingHash, daytonaSandboxName } from "./configuration";
import { DaytonaToolbox, DaytonaToolboxUncertain, daytonaCommandHash } from "./toolbox";

const configuration = {
    trustBoundary: "dedicated-organization" as const,
    networkAccess: "provider-default" as const,
    owner: "operator",
    organizationId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    target: "eu",
    apiKey: "synthetic-provider-key",
};
const reference = {
    runId: "33333333-3333-4333-8333-333333333333",
    sandboxId: "44444444-4444-4444-8444-444444444444",
};
const sessionId = `mira-${reference.runId}`;
const command = "bun --version";
const hash = daytonaCommandHash(command);
const commandId = "command-1";
const signal = new AbortController().signal;
const approve = () => Promise.resolve();
const commandRow = { id: commandId, command, exitCode: null };

function sandbox() {
    const created = Date.now() - 1000;
    return {
        id: reference.sandboxId,
        name: daytonaSandboxName(configuration, reference.runId),
        organizationId: configuration.organizationId,
        labels: {
            "homelab.owner": daytonaBindingHash(configuration),
            "homelab.run": reference.runId,
            "homelab.service": "mira",
        },
        state: "started",
        env: {},
        public: false,
        networkBlockAll: false,
        kvm: false,
        cpu: 2,
        memory: 4,
        disk: 10,
        gpu: 0,
        target: "eu",
        snapshot: configuration.snapshotId,
        autoDeleteInterval: 0,
        autoStopInterval: 5,
        autoPauseInterval: 0,
        createdAt: new Date(created).toISOString(),
        autoDestroyAt: new Date(created + 900_000).toISOString(),
    };
}
function control(path: string): Response {
    if (path === "/api/api-keys/current")
        return Response.json({
            organizationId: configuration.organizationId,
            userId: "owner",
            permissions: ["write:sandboxes", "delete:sandboxes"],
            expiresAt: null,
        });
    if (path.endsWith("/users"))
        return Response.json([
            {
                organizationId: configuration.organizationId,
                userId: "owner",
                role: "owner",
            },
        ]);
    if (path.includes("organizations"))
        return Response.json({ id: configuration.organizationId, suspended: false });
    if (path.includes("snapshots")) return new Response("unavailable", { status: 503 });
    return Response.json(sandbox());
}
function fixture(url: URL, init: RequestInit): Response {
    if (url.pathname.startsWith("/api/")) return control(url.pathname);
    if (url.pathname.endsWith("/process/session"))
        return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/exec"))
        return Response.json({ cmdId: commandId, output: "ignored" });
    if (url.pathname.endsWith("/logs"))
        return Response.json({ stdout: "result", stderr: "warning", output: "combined" });
    if (url.pathname.endsWith("/upload-v2"))
        return Response.json({ path: url.searchParams.get("path") });
    if (url.pathname.endsWith("/download")) return new Response("artifact");
    expect(init.method).toBe("GET");
    return Response.json({ sessionId, commands: [] });
}
function transport(
    handler: (url: URL, init: RequestInit) => Response | Promise<Response> = fixture
) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const request = Object.assign(
        async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
        ) => {
            if (typeof input !== "string" || !init)
                throw new Error("Expected explicit transport.");
            const url = new URL(input);
            expect(["https://app.daytona.io", "https://proxy.app.daytona.io"]).toContain(
                url.origin
            );
            if (url.origin.includes("proxy"))
                expect(url.pathname).toStartWith(`/toolbox/${reference.sandboxId}/`);
            expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(new Headers(init.headers).get("authorization")).toBe(
                `Bearer ${configuration.apiKey}`
            );
            calls.push({ url, init });
            return handler(url, init);
        },
        { preconnect: fetch.preconnect }
    );
    return {
        client: new DaytonaToolbox(configuration, reference, request),
        calls,
        request,
    };
}
function withCommand(url: URL, init: RequestInit): Response {
    return url.pathname.endsWith(`/session/${sessionId}`)
        ? Response.json({ sessionId, commands: [commandRow] })
        : fixture(url, init);
}

function mutation(
    client: DaytonaToolbox,
    phase: "open" | "submit" | "upload",
    cancellation: AbortSignal,
    guard: () => Promise<void>
) {
    if (phase === "open") return client.open(cancellation, guard);
    if (phase === "submit") return client.submit(command, cancellation, guard);
    return client.upload("input.txt", new Uint8Array([1]), cancellation, guard);
}

for (const value of ["", " ", "x\0y", "\uD800", "é".repeat(8193)])
    test("Daytona rejects invalid or oversized command bytes before making requests", async () => {
        const { client, calls } = transport();
        expect(() => daytonaCommandHash(value)).toThrow("Invalid Daytona command");
        await rejects(client.submit(value, signal, approve));
        expect(calls).toHaveLength(0);
    });
test("Daytona fingerprints exact Unicode and whitespace without normalization", () => {
    expect(daytonaCommandHash("echo 'æ 🐶'\n")).not.toBe(
        daytonaCommandHash("echo 'æ 🐶'")
    );
    expect(daytonaCommandHash("a".repeat(16_384))).toHaveLength(64);
    for (const change of [{ runId: "../secret" }, { sandboxId: "../secret" }])
        expect(
            () => new DaytonaToolbox(configuration, { ...reference, ...change })
        ).toThrow();
});

test("Daytona opens one fixed session only after the final durable gate", async () => {
    const { client, calls } = transport();
    await client.open(signal, () => {
        expect(calls.every((call) => call.init.method === "GET")).toBe(true);
        return Promise.resolve();
    });
    const writes = calls.filter((call) => call.init.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.init.body as string)).toEqual({ sessionId });
    expect(writes[0]!.url.pathname).toBe(
        `/toolbox/${reference.sandboxId}/process/session`
    );
});
for (const phase of ["open", "submit", "upload"] as const)
    test(`Daytona ${phase} respects revoked admission and cancellation before dispatch`, async () => {
        for (const cancel of [false, true]) {
            const { client, calls } = transport();
            const controller = new AbortController();
            const guard = () => {
                if (!cancel) return Promise.reject(new Error("permission changed"));
                controller.abort();
                return Promise.resolve();
            };
            const pending = mutation(client, phase, controller.signal, guard);
            await rejects(pending);
            expect(calls.every((call) => call.init.method === "GET")).toBe(true);
        }
    });

for (const change of [
    { state: "stopped" },
    { env: { SECRET: "private" } },
    { public: true },
    { otelEndpointOverride: "https://private.example/" },
    { labels: {} },
    { id: "55555555-5555-4555-8555-555555555555" },
    { autoDestroyAt: new Date(Date.now() + 20_000).toISOString() },
])
    test("Daytona refuses command dispatch after sandbox identity, settings or lifetime drift", async () => {
        const { client, calls } = transport((url, init) =>
            url.pathname.startsWith("/api/sandbox/")
                ? Response.json({ ...sandbox(), ...change })
                : fixture(url, init)
        );
        let admitted = false;
        await rejects(
            client.submit(command, signal, () => {
                admitted = true;
                return Promise.resolve();
            })
        );
        expect(admitted).toBe(false);
        expect(calls.every((call) => call.init.method === "GET")).toBe(true);
        expect(calls.every((call) => urlIsControl(call.url))).toBe(true);
    });
function urlIsControl(url: URL) {
    return url.origin === "https://app.daytona.io";
}
test("Daytona checks sole-owner membership afresh before toolbox writes", async () => {
    const { client, calls } = transport((url, init) =>
        url.pathname.endsWith("/users") ? Response.json([]) : fixture(url, init)
    );
    await rejects(client.open(signal, approve));
    expect(calls.every((call) => urlIsControl(call.url))).toBe(true);
});

test("Daytona sends the exact asynchronous command without host configuration", async () => {
    const { client, calls } = transport();
    expect(await client.submit(command, signal, approve)).toBe(commandId);
    const writes = calls.filter((call) => call.init.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.init.body as string)).toEqual({
        command,
        runAsync: true,
        suppressInputEcho: true,
    });
    expect(writes[0]!.init.body).not.toContain(configuration.apiKey);
});
for (const value of [
    null,
    { sessionId, commands: [commandRow] },
    { sessionId: "other", commands: [] },
])
    test("Daytona will not submit into an absent, used or mismatched session", async () => {
        const { client, calls } = transport((url, init) => {
            if (!url.pathname.endsWith(`/session/${sessionId}`))
                return fixture(url, init);
            return value ? Response.json(value) : new Response("absent", { status: 404 });
        });
        await rejects(client.submit(command, signal, approve));
        expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    });
for (const phase of ["open", "submit", "upload"] as const)
    for (const failure of ["http", "lost", "abort"] as const)
        test(`Daytona ${phase} retains an uncertain ${failure} attempt without replay`, async () => {
            const controller = new AbortController();
            const { client, calls } = transport((url, init) => {
                if (init.method !== "POST") return fixture(url, init);
                if (failure === "http")
                    return new Response("private-provider-secret", { status: 502 });
                if (failure === "abort") controller.abort();
                throw new Error("private-provider-secret");
            });
            const pending = mutation(client, phase, controller.signal, approve);
            await rejects(pending, (error) => {
                expect(error).toBeInstanceOf(DaytonaToolboxUncertain);
                expect((error as DaytonaToolboxUncertain).reference).toEqual(reference);
                expect(String(error)).not.toContain("private");
                return true;
            });
            expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
        });
for (const value of [{}, { cmdId: "../secret" }, { cmdId: "" }])
    test("Daytona keeps malformed command acknowledgements uncertain", async () => {
        const { client } = transport((url, init) =>
            url.pathname.endsWith("/exec") ? Response.json(value) : fixture(url, init)
        );
        await rejects(client.submit(command, signal, approve), DaytonaToolboxUncertain);
    });

for (const result of [undefined, null, 0, 1, 137])
    test("Daytona recovers the exact command and distinguishes running from any exit code", async () => {
        const { client, calls } = transport((url, init) =>
            url.pathname.endsWith(`/session/${sessionId}`)
                ? Response.json({
                      sessionId,
                      commands: [{ ...commandRow, exitCode: result }],
                  })
                : fixture(url, init)
        );
        expect(await client.inspect(hash, signal)).toEqual({
            state: result === null || result === undefined ? "running" : "completed",
            commandId,
            exitCode: result ?? null,
        });
        expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    });
test("Daytona distinguishes missing and empty sessions without authorizing retries", async () => {
    const empty = transport();
    expect(await empty.client.inspect(hash, signal)).toEqual({
        state: "empty",
        commandId: null,
        exitCode: null,
    });
    const absent = transport((url, init) =>
        url.pathname.endsWith(`/session/${sessionId}`)
            ? new Response("missing", { status: 404 })
            : fixture(url, init)
    );
    expect(await absent.client.inspect(hash, signal)).toEqual({
        state: "absent",
        commandId: null,
        exitCode: null,
    });
});
for (const commands of [
    [{ ...commandRow, command: "private-command" }],
    [{ ...commandRow, id: "../private" }],
    [commandRow, commandRow],
    [{ ...commandRow, exitCode: "0" }],
])
    test("Daytona rejects replaced, duplicate or malformed commands without returning their content", async () => {
        const { client } = transport((url, init) =>
            url.pathname.endsWith(`/session/${sessionId}`)
                ? Response.json({ sessionId, commands })
                : fixture(url, init)
        );
        await rejects(client.inspect(hash, signal), (error) => {
            expect(String(error)).not.toContain("private");
            return true;
        });
    });
test("Daytona verifies persisted command IDs and rejects unsafe references before I/O", async () => {
    const { client, calls } = transport(withCommand);
    await rejects(client.inspect("invalid", signal));
    await rejects(client.inspect(hash, signal, "../other"));
    expect(calls).toHaveLength(0);
    await rejects(client.inspect(hash, signal, "other"), /approved command/);
});

test("Daytona reads a non-following log snapshot after checking command identity", async () => {
    const { client, calls } = transport(withCommand);
    expect(await client.logs(hash, commandId, signal)).toEqual({
        stdout: "result",
        stderr: "warning",
        output: "combined",
    });
    const last = calls.at(-1)!;
    expect(last.url.searchParams.get("follow")).toBe("false");
    expect(last.url.pathname).toEndWith(`/command/${commandId}/logs`);
    expect(calls.every((call) => call.init.method === "GET")).toBe(true);
});
for (const value of [
    {},
    { stdout: null },
    { stdout: "x".repeat(65_537) },
    { stdout: "é".repeat(60_000), stderr: "é".repeat(60_000) },
])
    test("Daytona explicitly rejects malformed or oversized logs", async () => {
        const { client } = transport((url, init) =>
            url.pathname.endsWith("/logs") ? Response.json(value) : withCommand(url, init)
        );
        await rejects(client.logs(hash, commandId, signal));
    });
test("Daytona accepts an explicitly empty log but does not invent a missing command", async () => {
    const { client } = transport((url, init) =>
        url.pathname.endsWith("/logs")
            ? Response.json({ output: "" })
            : withCommand(url, init)
    );
    expect(await client.logs(hash, commandId, signal)).toEqual({
        stdout: "",
        stderr: "",
        output: "",
    });
    const empty = transport();
    await rejects(empty.client.logs(hash, commandId, signal));
    expect(empty.calls.some((call) => call.url.pathname.endsWith("/logs"))).toBe(false);
});

test("Daytona copies approved upload bytes before awaiting and confirms the exact destination", async () => {
    const { client, calls } = transport();
    const bytes = new Uint8Array([1, 2, 3]);
    const pending = client.upload("src/input.bin", bytes, signal, approve);
    bytes.fill(9);
    expect(await pending).toBe(
        `/tmp/homelab-mira/${reference.runId}/inputs/src/input.bin`
    );
    const write = calls.find((call) => call.init.method === "POST")!;
    expect(new Headers(write.init.headers).has("content-type")).toBe(false);
    expect(write.init.body).toBeInstanceOf(FormData);
    const request = new Request(write.url.href, {
        method: "POST",
        headers: new Headers(write.init.headers),
        body: write.init.body as FormData,
    });
    expect(request.headers.get("content-type")).toStartWith(
        "multipart/form-data; boundary="
    );
    const form = await request.formData();
    expect([...form.keys()]).toEqual(["file"]);
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    const uploaded = await (file as File).arrayBuffer();
    expect(new Uint8Array(uploaded)).toEqual(new Uint8Array([1, 2, 3]));
});
test("Daytona rejects changed upload acknowledgements and inputs after command dispatch", async () => {
    const wrong = transport((url, init) =>
        url.pathname.endsWith("/upload-v2")
            ? Response.json({ path: "/private" })
            : fixture(url, init)
    );
    await rejects(
        wrong.client.upload("input", new Uint8Array(), signal, approve),
        DaytonaToolboxUncertain
    );
    const used = transport(withCommand);
    await rejects(
        used.client.upload("input", new Uint8Array(), signal, approve),
        /cannot change/
    );
    expect(used.calls.every((call) => call.init.method === "GET")).toBe(true);
});
for (const name of [
    "",
    "/etc/passwd",
    "../secret",
    "a/../b",
    "a/./b",
    String.raw`a\b`,
    "a%2fb",
    "a?x=1",
    "a\n",
    "a".repeat(513),
])
    test("Daytona rejects paths outside a selected attempt directory before I/O", async () => {
        const { client, calls } = transport();
        await rejects(client.download(name, signal));
        await rejects(client.upload(name, new Uint8Array(), signal, approve));
        expect(calls).toHaveLength(0);
    });
test("Daytona rejects oversized inputs before I/O", async () => {
    const { client, calls } = transport();
    await rejects(
        client.upload("input", new Uint8Array(1024 * 1024 + 1), signal, approve)
    );
    expect(calls).toHaveLength(0);
});
test("Daytona returns selected artifacts only as bounded untrusted bytes", async () => {
    const { client, calls } = transport();
    const bytes = await client.download("test/results.json", signal);
    expect(new TextDecoder().decode(bytes!)).toBe("artifact");
    expect(calls.at(-1)!.url.searchParams.get("path")).toBe(
        `/tmp/homelab-mira/${reference.runId}/outputs/test/results.json`
    );
    const absent = transport((url, init) =>
        url.pathname.endsWith("/download")
            ? new Response(null, { status: 404 })
            : fixture(url, init)
    );
    expect(await absent.client.download("missing", signal)).toBeNull();
});
for (const advertised of [true, false])
    test("Daytona cancels advertised and streamed oversized artifact bodies", async () => {
        let cancelled = 0;
        const { client } = transport((url, init) =>
            url.pathname.endsWith("/download")
                ? new Response(
                      new ReadableStream<Uint8Array>({
                          pull(controller) {
                              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
                          },
                          cancel() {
                              cancelled++;
                          },
                      }),
                      { headers: advertised ? { "content-length": "1048577" } : {} }
                  )
                : fixture(url, init)
        );
        await rejects(client.download("result", signal), /1 MiB/);
        expect(cancelled).toBe(1);
    });
test("Daytona cancellation during a response body propagates without a new request", async () => {
    const controller = new AbortController();
    const { client, calls } = transport((url, init) => {
        if (!url.pathname.endsWith("/download")) return fixture(url, init);
        return new Response(
            new ReadableStream<Uint8Array>({
                start(stream) {
                    init.signal!.addEventListener(
                        "abort",
                        () => stream.error(new Error("cancelled")),
                        { once: true }
                    );
                    controller.abort();
                },
            })
        );
    });
    await rejects(client.download("result", controller.signal));
    expect(calls.filter((call) => call.url.pathname.endsWith("/download"))).toHaveLength(
        1
    );
});

test("Daytona advertises the installed client version to negotiate structured logs", async () => {
    const { client, calls } = transport((url, init) => {
        if (!url.pathname.endsWith("/logs")) return withCommand(url, init);
        if (new Headers(init.headers).get("x-daytona-sdk-version") !== toolboxVersion)
            return new Response("legacy plain text");
        return Response.json({ stdout: "structured", stderr: "", output: "structured" });
    });
    expect(await client.logs(hash, commandId, signal)).toEqual({
        stdout: "structured",
        stderr: "",
        output: "structured",
    });
    for (const call of calls.filter((entry) => !urlIsControl(entry.url)))
        expect(new Headers(call.init.headers).get("x-daytona-sdk-version")).toBe(
            toolboxVersion
        );
});

for (const phase of ["open", "submit", "upload"] as const)
    for (const delay of [31_000, 61_000])
        test(`Daytona ${phase} rechecks expiry after slow authorization without dispatch`, async () => {
            const initial = Date.now();
            let now = initial;
            const { request, calls } = transport((url, init) =>
                url.pathname.startsWith("/api/sandbox/")
                    ? Response.json({
                          ...sandbox(),
                          autoDestroyAt: new Date(initial + 60_000).toISOString(),
                      })
                    : fixture(url, init)
            );
            const client = new DaytonaToolbox(
                configuration,
                reference,
                request,
                () => now
            );
            let admitted = false;
            await rejects(
                mutation(client, phase, signal, () => {
                    admitted = true;
                    now += delay;
                    return Promise.resolve();
                }),
                /less than 30 seconds/
            );
            expect(admitted).toBe(true);
            expect(calls.every((call) => call.init.method === "GET")).toBe(true);
        });
