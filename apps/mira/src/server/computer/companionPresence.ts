import { setTimeout as delay } from "node:timers/promises";

import { type ComputerCompanion, ComputerConnectionError } from "./companion";

/**
 * Maintain outbound presence until stopped, rejected or expired, without executing remote commands.
 * @param options - Fixed companion, device credential, expiry, local stop and content-free status sink.
 * @returns Completion on local stop; terminal failures require operator action.
 */
export async function runComputerPresence(options: {
    companion: ComputerCompanion;
    credential: string;
    expiresAt: string;
    signal: AbortSignal;
    status: (status: "connected" | "reconnecting" | "stopped") => void;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
    const wait =
        options.wait ??
        ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
    try {
        while (!options.signal.aborted) {
            if (
                Date.parse(options.expiresAt) <= Date.now() ||
                !Number.isFinite(Date.parse(options.expiresAt))
            )
                throw new Error("Computer pairing expired. Pair again in Settings.");
            try {
                const connection = await options.companion.connect(
                    options.credential,
                    options.signal
                );
                options.status("connected");
                for (let sequence = 1; sequence <= 2_147_483_647; sequence++) {
                    await wait(connection.heartbeatSeconds * 1000, options.signal);
                    options.signal.throwIfAborted();
                    await options.companion.heartbeat(
                        options.credential,
                        connection.connectionId,
                        sequence,
                        options.signal
                    );
                }
            } catch (error) {
                if (options.signal.aborted) break;
                if (!(error instanceof ComputerConnectionError) || !error.retryable)
                    throw error;
                options.status("reconnecting");
                await wait(30_000, options.signal);
            }
        }
    } catch (error) {
        if (!options.signal.aborted) throw error;
    } finally {
        options.status("stopped");
    }
}
