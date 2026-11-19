import { connect } from "node:net";

import {
    browserClipboardCommandSchema,
    browserClipboardResultSchema,
} from "@homelab/contracts/miraBrowserClipboard";
import { browserLiveSocket } from "@homelab/mira/browsing/liveSocket";
import { Effect } from "effect";
import * as v from "valibot";

import { boundedRequestBody } from "../http/requestBody";
import type { OperationsContext } from "../operations/context";
import { prepareBrowserDisplay } from "./browserDisplay";

/** Transfer plain text for one current, signed-in human clipboard gesture.
 * @param request - Same-origin authenticated POST; never accepted from model tools.
 * @param context - Existing human identity and session verifier.
 * @returns A bounded, non-cacheable result; clipboard text is not persisted or logged.
 */
export async function browserClipboardRequest(
    request: Request,
    context: OperationsContext
): Promise<Response> {
    const headers = {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    };
    return Effect.runPromise(
        Effect.tryPromise({
            try: async () => {
                const access = await prepareBrowserDisplay(request, context);
                if (!access.control)
                    throw new Error("Take control to use the clipboard.");
                const bounded = await boundedRequestBody(request, 64 * 1024);
                if (!bounded) throw new Error("Clipboard text is too long.");
                const clipboard = v.parse(
                    browserClipboardCommandSchema,
                    await bounded.json()
                );
                request.signal.throwIfAborted();
                const result = await new Promise<unknown>((resolve, reject) => {
                    const socket = connect(
                        browserLiveSocket(access.directory, access.hostId)
                    );
                    let buffer = Buffer.alloc(0);
                    let settled = false;
                    const finish = (value?: unknown) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        request.signal.removeEventListener("abort", cancel);
                        socket.destroy();
                        if (value === undefined)
                            reject(new Error("Clipboard transfer did not finish."));
                        else resolve(value);
                    };
                    const cancel = () => finish();
                    const timer = setTimeout(cancel, 15_000);
                    request.signal.addEventListener("abort", cancel, { once: true });
                    if (request.signal.aborted) cancel();
                    socket.on("connect", () =>
                        socket.write(
                            JSON.stringify({ ...access.identity, clipboard }) + "\n"
                        )
                    );
                    socket.on("error", cancel);
                    socket.on("close", cancel);
                    socket.on("data", (bytes: Buffer) => {
                        buffer = Buffer.concat([buffer, bytes]);
                        if (buffer.length > 64 * 1024) return cancel();
                        if (buffer.includes(10)) {
                            try {
                                finish(
                                    v.parse(
                                        browserClipboardResultSchema,
                                        JSON.parse(
                                            new TextDecoder("utf-8", {
                                                fatal: true,
                                            }).decode(buffer)
                                        )
                                    )
                                );
                            } catch {
                                cancel();
                            }
                        }
                    });
                });
                await access.verify();
                return Response.json(result, { headers });
            },
            catch: () => new Error("Clipboard transfer did not finish."),
        })
    ).catch(() => Response.json({ ok: false }, { status: 409, headers }));
}
