import * as v from "valibot";

import { browserEndpoint } from "./endpoint";

const targetId = v.pipe(v.string(), v.regex(/^[A-F0-9]{32}$/u));
const targetsSchema = v.object({
    targetInfos: v.pipe(
        v.array(
            v.object({
                targetId,
                type: v.pipe(v.string(), v.maxLength(64)),
                url: v.pipe(v.string(), v.maxLength(2048)),
            })
        ),
        v.maxLength(128)
    ),
});

/**
 * Open tab lifecycle operations for this container's driver-owned Chromium only.
 * @param pid - Process already attested by browser_prepare.
 * @param signal - Permanent cancellation of the native browser lifetime.
 * @param resolveEndpoint - Private endpoint resolver; a synthetic replacement is for tests only.
 * @returns Page inventory, blank-tab creation and exact-tab closure, with no arbitrary CDP interface.
 */
export async function openBrowserTabLifecycle(
    pid: number,
    signal: AbortSignal,
    resolveEndpoint = browserEndpoint
) {
    const endpoint = await resolveEndpoint(pid);
    const request = async (
        method: "Target.getTargets" | "Target.createTarget" | "Target.closeTarget",
        params: Record<string, unknown>,
        operation: AbortSignal
    ) => {
        const combined = AbortSignal.any([signal, operation, AbortSignal.timeout(5000)]);
        combined.throwIfAborted();
        if (!(await endpoint.alive()))
            throw new Error("Browser process is no longer owned.");
        const result = await new Promise<unknown>((resolve, reject) => {
            const socket = new WebSocket(endpoint.url);
            let finished = false;
            const finish = (error?: Error, value?: unknown) => {
                if (finished) return;
                finished = true;
                combined.removeEventListener("abort", abort);
                socket.close();
                if (error) reject(error);
                else resolve(value);
            };
            const abort = () => finish(new Error("Browser tab operation stopped."));
            combined.addEventListener("abort", abort, { once: true });
            socket.addEventListener("open", () => {
                if (combined.aborted) abort();
                else socket.send(JSON.stringify({ id: 1, method, params }));
            });
            socket.addEventListener("error", () =>
                finish(new Error("Browser tab connection failed."))
            );
            socket.addEventListener("close", () =>
                finish(new Error("Browser tab connection closed."))
            );
            socket.addEventListener("message", (event) => {
                try {
                    if (
                        typeof event.data !== "string" ||
                        Buffer.byteLength(event.data) > 64 * 1024
                    )
                        throw new Error("Invalid browser tab response.");
                    const reply = v.parse(
                        v.object({ id: v.literal(1), result: v.unknown() }),
                        JSON.parse(event.data)
                    );
                    if (reply.result === undefined)
                        throw new Error("Browser tab operation failed.");
                    finish(undefined, reply.result);
                } catch {
                    finish(new Error("Invalid browser tab response."));
                }
            });
            if (combined.aborted) abort();
        });
        combined.throwIfAborted();
        if (!(await endpoint.alive()))
            throw new Error("Browser process changed during tab operation.");
        return result;
    };
    return {
        pages: async (operation: AbortSignal) =>
            v
                .parse(targetsSchema, await request("Target.getTargets", {}, operation))
                .targetInfos.filter((target) => target.type === "page"),
        create: async (operation: AbortSignal) =>
            v.parse(
                v.object({ targetId }),
                await request(
                    "Target.createTarget",
                    { url: "about:blank", background: true },
                    operation
                )
            ).targetId,
        close: async (id: string, operation: AbortSignal) => {
            v.parse(
                v.object({ success: v.literal(true) }),
                await request(
                    "Target.closeTarget",
                    { targetId: v.parse(targetId, id) },
                    operation
                )
            );
        },
    };
}
