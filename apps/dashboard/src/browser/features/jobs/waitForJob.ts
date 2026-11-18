import { api } from "../../api/client";

/**
 * Wait for an accepted check without submitting a second job or installation.
 * @param id - Exact accepted job identity.
 * @param signal - Calling dialog lifetime.
 * @param state - Read-only job status transport.
 * @param failure - Safe explanation when the check does not succeed.
 * @returns Completion only after the accepted job succeeds.
 */
export async function waitForJob(
    id: string,
    signal: AbortSignal,
    state: (id: string, signal: AbortSignal) => Promise<string> = async (id, signal) => {
        const detail = await api.jobs.detail.query({ id, limit: 1 }, { signal });
        if (
            !["queued", "running", "succeeded"].includes(detail.run.state) &&
            detail.run.message
        )
            throw new Error(detail.run.message);
        return detail.run.state;
    },
    failure = "Release checks did not complete successfully. Open Jobs to inspect the check."
): Promise<void> {
    // The worker owns execution deadlines and retries. Queue time, large
    // inventories and paused workers must not invalidate a still-live check.
    while (true) {
        signal.throwIfAborted();
        const current = await state(id, signal);
        if (current === "succeeded") return;
        if (!["queued", "running"].includes(current)) throw new Error(failure);
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                reject(new Error("Preparation cancelled", { cause: signal.reason }));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, 1000);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
        });
    }
}
