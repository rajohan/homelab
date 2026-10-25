import { publishDaytonaBinding } from "@homelab/mira/data/daytona";
import { publishHereNowBinding } from "@homelab/mira/data/herenow";
import { publishAgentMailReceiver } from "@homelab/mira/data/integrations";
import { publishMoltbookBinding } from "@homelab/mira/data/moltbook";
import {
    acceptAgentMailMessage,
    verifyAgentMailWebhook,
} from "@homelab/mira/integrations/agentmail/webhook";

import type { OperationsRuntime } from "../operations/runtime";

const response = (status: number) =>
    new Response(null, { status, headers: { "cache-control": "no-store" } });

async function rawBody(request: Request): Promise<string> {
    if (!request.body || Number(request.headers.get("content-length")) > 262_144)
        throw new Error("Invalid webhook body.");
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error("Webhook body timed out."));
            void reader.cancel().catch(() => {});
        }, 10_000);
    });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), deadline]);
            if (next.done) break;
            const chunk: unknown = next.value;
            if (!(chunk instanceof Uint8Array)) throw new Error("Invalid webhook chunk.");
            length += chunk.byteLength;
            if (length > 262_144) {
                await reader.cancel();
                throw new Error("Webhook body too large.");
            }
            chunks.push(chunk);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
        clearTimeout(timer);
        reader.releaseLock();
    }
}

/**
 * Accept signed provider events independently of browser sign-in and inference availability.
 * @param operations - Explicit database and webhook configuration; absent settings fail closed.
 * @returns A bounded receiver that acknowledges only after the durable transaction commits.
 */
export function agentMailWebhookReceiver(
    operations?: Pick<OperationsRuntime, "client" | "agentMailHook">
) {
    let active = 0;
    return async (request: Request): Promise<Response> => {
        if (!operations?.agentMailHook) return response(404);
        if (request.method !== "POST") return response(405);
        if (
            request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
            "application/json"
        )
            return response(415);
        if (
            ["svix-id", "svix-timestamp", "svix-signature"].some((name) => {
                const value = request.headers.get(name);
                return !value || value.length > 4096;
            })
        )
            return response(400);
        if (active >= 4) return response(429);
        active++;
        try {
            let message: ReturnType<typeof verifyAgentMailWebhook>;
            try {
                message = verifyAgentMailWebhook(
                    await rawBody(request),
                    request.headers,
                    operations.agentMailHook
                );
            } catch {
                return response(400);
            }
            if (message === null) return response(204);
            try {
                await acceptAgentMailMessage(
                    operations.client,
                    operations.agentMailHook,
                    message.messageId,
                    message.observedAt,
                    message.availableAt
                );
            } catch {
                return response(503);
            }
            return response(204);
        } finally {
            active--;
        }
    };
}

/**
 * Keep dashboard integration bindings fresh for reads and timed resume.
 * @param operations - This dashboard's database and optional integration bindings.
 * @returns Shutdown hook that stops publication before the owning pool closes.
 */
export function agentMailReceiverHeartbeat(
    operations?: Pick<
        OperationsRuntime,
        | "client"
        | "agentMailHook"
        | "moltbookBinding"
        | "hereNowBinding"
        | "daytonaBinding"
    >
): () => Promise<void> {
    let pending: Promise<unknown> | undefined;
    const publish = () => {
        if (!operations || pending) return;
        pending = Promise.allSettled([
            publishAgentMailReceiver(operations.client, operations.agentMailHook),
            publishMoltbookBinding(operations.client, operations.moltbookBinding),
            publishHereNowBinding(operations.client, operations.hereNowBinding),
            publishDaytonaBinding(operations.client, operations.daytonaBinding),
        ])
            .catch(() => {
                /* Expired evidence keeps timed resumption paused until the database recovers. */
            })
            .finally(() => {
                pending = undefined;
            });
    };
    publish();
    const timer = setInterval(publish, 15_000);
    timer.unref();
    return async () => {
        clearInterval(timer);
        await pending;
    };
}
