import { setTimeout as delay } from "node:timers/promises";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import { type ComputerCompanion, ComputerConnectionError } from "./companion";

/**
 * Maintain presence and optional generation-owned work, reaping it before every reconnect.
 * @param options - Fixed companion, vault credential, stop/status hooks and optional local connection work.
 * @returns Completion on local stop; terminal failures require operator action.
 */
export async function runComputerPresence(options: {
    companion: ComputerCompanion;
    credential: string;
    expiresAt: string;
    signal: AbortSignal;
    status: (status: "connected" | "reconnecting" | "stopped") => void;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    /** Must resolve after clean cancellation and reject if local cleanup is unconfirmed. */
    connectionWork?: (
        scope: Readonly<{ connectionId: string; signal: AbortSignal }>
    ) => Promise<void>;
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
                options.signal.throwIfAborted();
                options.status("connected");
                await runGeneration(options, connection, wait);
            } catch (error) {
                if (error instanceof RuntimeCleanupError) throw error;
                if (options.signal.aborted) break;
                if (!(error instanceof ComputerConnectionError) || !error.retryable)
                    throw error;
                options.status("reconnecting");
                await wait(30_000, options.signal);
            }
        }
    } catch (error) {
        if (error instanceof RuntimeCleanupError || !options.signal.aborted) throw error;
    } finally {
        options.status("stopped");
    }
}

type PresenceOptions = Parameters<typeof runComputerPresence>[0];
async function runGeneration(
    options: PresenceOptions,
    connection: Awaited<ReturnType<ComputerCompanion["connect"]>>,
    wait: NonNullable<PresenceOptions["wait"]>
): Promise<void> {
    const retirement = new AbortController();
    const signal = AbortSignal.any([options.signal, retirement.signal]);
    const heartbeat = async () => {
        for (let sequence = 1; sequence <= 2_147_483_647; sequence++) {
            await wait(connection.heartbeatSeconds * 1000, signal);
            signal.throwIfAborted();
            await options.companion.heartbeat(
                options.credential,
                connection.connectionId,
                sequence,
                signal
            );
        }
    };
    const tasks: Promise<void>[] = [heartbeat()];
    if (options.connectionWork)
        tasks.push(
            Promise.resolve().then(() => {
                if (signal.aborted) return;
                return options.connectionWork!(
                    Object.freeze({ connectionId: connection.connectionId, signal })
                );
            })
        );
    let failure: unknown;
    try {
        await Promise.race(tasks);
        failure = new Error("Computer connection work ended unexpectedly.");
    } catch (error) {
        failure = error;
    }
    retirement.abort();
    const results = await Promise.allSettled(tasks);
    const work = results[1];
    if (
        work?.status === "rejected" &&
        (work.reason instanceof RuntimeCleanupError ||
            work.reason !== failure ||
            options.signal.aborted)
    )
        throw new RuntimeCleanupError();
    if (failure instanceof RuntimeCleanupError || !options.signal.aborted) throw failure;
}
