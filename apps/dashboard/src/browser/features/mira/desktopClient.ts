import * as v from "valibot";

const stateSchema = v.strictObject({
    message: v.pipe(v.string(), v.maxLength(512)),
    computerId: v.nullable(v.pipe(v.string(), v.uuid())),
    busy: v.boolean(),
    canStart: v.boolean(),
    canStop: v.boolean(),
    canUpdate: v.boolean(),
});
const replySchema = v.strictObject({
    type: v.literal("mira-desktop"),
    protocol: v.literal(1),
    id: v.pipe(v.string(), v.uuid()),
    state: stateSchema,
    error: v.nullable(v.pipe(v.string(), v.maxLength(512))),
});
export type DesktopState = v.InferOutput<typeof stateSchema>;
type DesktopRequest =
    | { readonly action: "state" | "connect" | "stop" | "forget" | "update" }
    | { readonly action: "pair"; readonly ticket: string };
interface WebViewBridge {
    postMessage: (message: unknown) => void;
    addEventListener: (event: "message", listener: (event: MessageEvent) => void) => void;
    removeEventListener: (
        event: "message",
        listener: (event: MessageEvent) => void
    ) => void;
}
function bridge(): WebViewBridge | undefined {
    return (globalThis as typeof globalThis & { chrome?: { webview?: WebViewBridge } })
        .chrome?.webview;
}

/**
 * Detect the optional Windows shell.
 * @returns Whether the local message bridge exists; web features remain independent.
 */
export function hasDesktopBridge(): boolean {
    return typeof bridge()?.postMessage === "function";
}

/**
 * Request one fixed Windows operation without sending account cookies or provider credentials.
 * @param input - Local connection action; pairing carries only the one-use enrollment ticket.
 * @param signal - Cancels the local wait, never retries an uncertain operation.
 * @returns An acknowledged local state, not proof that an asynchronous connection/update finished.
 */
export function requestDesktop(
    input: DesktopRequest,
    signal?: AbortSignal
): Promise<DesktopState> {
    const host = bridge();
    if (!host)
        return Promise.reject(
            new Error("Open Mira for Windows to use local computer controls.")
        );
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            host.removeEventListener("message", receive);
            signal?.removeEventListener("abort", cancel);
        };
        const cancel = () => {
            cleanup();
            reject(new Error("The local request was cancelled."));
        };
        const receive = (event: MessageEvent<unknown>) => {
            const result = v.safeParse(replySchema, event.data);
            if (!result.success || result.output.id !== id) return;
            cleanup();
            if (result.output.error) reject(new Error(result.output.error));
            else resolve(result.output.state);
        };
        host.addEventListener("message", receive);
        signal?.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => {
            cleanup();
            reject(
                new Error(
                    "Mira for Windows did not respond. Check the app before trying again."
                )
            );
        }, 8000);
        if (signal?.aborted) {
            cancel();
            return;
        }
        try {
            host.postMessage({ type: "mira-desktop", protocol: 1, id, ...input });
        } catch {
            cleanup();
            reject(new Error("The local request could not be sent."));
        }
    });
}
