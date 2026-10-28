import {
    acceptMiraComputerAccess,
    pendingMiraComputerAccess,
    permitMiraComputerAccessLocally,
    stopMiraComputerAccessLocally,
} from "@homelab/mira/data/computerAccess";
import {
    claimMiraComputerCommand,
    finishMiraComputerCommand,
} from "@homelab/mira/data/computerCommands";
import {
    connectMiraComputer,
    enrollMiraComputer,
    heartbeatMiraComputer,
} from "@homelab/mira/data/computers";
import { MiraFailure } from "@homelab/mira/data/context";
import type { SQL } from "bun";
import { Effect } from "effect";
import * as v from "valibot";

const response = (status: number, data?: unknown) =>
    Response.json(data ?? { error: "Computer request was refused." }, {
        status,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });

async function body(request: Request, maximumBytes: number): Promise<unknown> {
    if (!request.body || Number(request.headers.get("content-length")) > maximumBytes)
        throw new Error("Invalid body.");
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error("Body deadline."));
            void reader.cancel().catch(() => {});
        }, 5000);
    });
    let bytes = Buffer.alloc(0);
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), deadline]);
            if (next.done) break;
            const chunk: unknown = next.value;
            if (
                !(chunk instanceof Uint8Array) ||
                bytes.length + chunk.length > maximumBytes
            ) {
                await reader.cancel();
                throw new Error("Body limit.");
            }
            bytes = Buffer.concat([bytes, chunk]);
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
        clearTimeout(timer);
        reader.releaseLock();
    }
}

/**
 * Accept bounded private device traffic without admitting browser credentials or public command producers.
 * @param client - Explicit database, supplied only when dashboard identity and operations are configured.
 * @returns A bounded machine-only receiver; its credential can never access tRPC or automation APIs.
 */
export function miraComputerReceiver(client?: SQL) {
    let active = 0;
    return async (request: Request): Promise<Response> => {
        if (!client) return response(503);
        const url = new URL(request.url);
        if (
            ![
                "/api/mira/computers/enroll",
                "/api/mira/computers/connect",
                "/api/mira/computers/heartbeat",
                "/api/mira/computers/access/pending",
                "/api/mira/computers/access/accept",
                "/api/mira/computers/access/stop",
                "/api/mira/computers/access/permit",
                "/api/mira/computers/commands/claim",
                "/api/mira/computers/commands/finish",
            ].includes(url.pathname) ||
            url.search
        )
            return response(404);
        if (request.method !== "POST") return response(405);
        if (request.headers.has("origin") || request.headers.has("cookie"))
            return response(403);
        if (
            request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
            "application/json"
        )
            return response(415);
        const auth = request.headers.get("authorization") ?? "";
        if (!/^Bearer mira_(?:pair|device)_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(auth))
            return response(403);
        if (active >= 8) return response(429);
        active++;
        try {
            let input: unknown;
            try {
                input = await body(
                    request,
                    url.pathname.endsWith("/commands/finish") ? 3 * 1024 * 1024 : 2048
                );
            } catch {
                return response(400);
            }
            const token = auth.slice(7);
            const result = await Effect.runPromise(
                Effect.tryPromise({
                    try: async () => {
                        if (url.pathname.endsWith("/commands/claim"))
                            return await claimMiraComputerCommand(client, token, input);
                        if (url.pathname.endsWith("/commands/finish"))
                            return await finishMiraComputerCommand(client, token, input);
                        if (url.pathname.endsWith("/access/pending"))
                            return await pendingMiraComputerAccess(client, token, input);
                        if (url.pathname.endsWith("/access/permit"))
                            return await permitMiraComputerAccessLocally(
                                client,
                                token,
                                input
                            );
                        if (url.pathname.endsWith("/access/accept"))
                            return await acceptMiraComputerAccess(client, token, input);
                        if (url.pathname.endsWith("/access/stop")) {
                            await stopMiraComputerAccessLocally(client, token, input);
                            return { stopped: true };
                        }
                        if (url.pathname.endsWith("/enroll"))
                            return await enrollMiraComputer(client, token, input);
                        if (url.pathname.endsWith("/heartbeat"))
                            return await heartbeatMiraComputer(client, token, input);
                        v.parse(v.strictObject({}), input);
                        return await connectMiraComputer(client, token);
                    },
                    catch: (error: unknown) => error,
                }).pipe(Effect.result)
            );
            if (result._tag === "Success") return response(200, result.success);
            if (v.isValiError(result.failure)) return response(400);
            if (result.failure instanceof MiraFailure) return response(403);
            return response(503);
        } finally {
            active--;
        }
    };
}
