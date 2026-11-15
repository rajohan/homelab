import { api } from "../../api/client";
import { waitForJob } from "../jobs/waitForJob";

interface PreparationInput {
    readonly requestId: string;
    readonly source?: string;
    readonly target?: string;
}
const transport = {
    start: async (input: PreparationInput, signal: AbortSignal) =>
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
    await waitForJob(
        id,
        signal,
        client.state,
        "Current software status could not be refreshed. Open Jobs to inspect the check before updating."
    );
}
