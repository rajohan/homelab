import { api } from "../../api/client";

interface PreparationInput {
    readonly requestId: string;
    readonly source?: string;
    readonly target?: string;
}
const transport = {
    start: (input: PreparationInput, signal: AbortSignal) =>
        api.updates.prepare.mutate(input, { signal }),
    state: async (id: string, signal: AbortSignal) => {
        const detail = await api.jobs.detail.query({ id, limit: 1 }, { signal });
        return detail.run.state;
    },
};

/**
 * Await the shared read-only worker check before showing an exact update confirmation.
 * @param input - Stable request identity and optional configured host or target scope.
 * @param signal - Dialog lifetime; cancellation never submits an installation.
 * @param client - Queue/status boundary, replaced by fixtures in tests.
 * @returns Completion only after a successful current inventory check.
 */
export async function prepareUpdate(
    input: PreparationInput,
    signal: AbortSignal,
    client = transport
): Promise<void> {
    signal.throwIfAborted();
    const { id } = await client.start(input, signal);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
        signal.throwIfAborted();
        const state = await client.state(id, signal);
        if (state === "succeeded") return;
        if (!["queued", "running"].includes(state))
            throw new Error(
                "Current software status could not be refreshed. Open Jobs to inspect the check before updating."
            );
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                reject(
                    new Error("Update preparation cancelled", { cause: signal.reason })
                );
            };
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, 1000);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
        });
    }
    throw new Error(
        "The update check is still running. Open Jobs to inspect it, then reopen the update plan."
    );
}
