import { setTimeout as delay } from "node:timers/promises";

import type { SQL } from "bun";

import {
    localCodeBindingHash,
    publishLocalCodeBinding,
    type LocalCodeBinding,
} from "./localBinding";
import { dispatchMiraLocalCode } from "./localJobs";

/**
 * Keep the local target available while one durable code job runs independently of browser work.
 * @param options - Trusted host configuration, private files/database and permanent shutdown signal.
 * @param dispatch - Synthetic job boundary for lifecycle tests; production uses the fenced Docker dispatcher.
 * @returns Completion after the active attempt stops and cleanup finishes; uncertain cleanup stays in the queue.
 */
export async function runMiraLocalCodeHost(
    options: {
        client: SQL;
        binding: LocalCodeBinding;
        socketPath: string;
        filesDirectory: string | undefined;
        signal: AbortSignal;
    },
    dispatch = dispatchMiraLocalCode
): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let active: Promise<unknown> | undefined;
    let failed = false;
    let nextHeartbeat = 0;
    let heartbeat: string | undefined;
    try {
        while (!signal.aborted) {
            if (Date.now() >= nextHeartbeat) {
                heartbeat = await publishLocalCodeBinding(
                    options.client,
                    options.binding
                );
                nextHeartbeat = Date.now() + 5000;
            }
            signal.throwIfAborted();
            if (!active)
                active = dispatch({ ...options, signal })
                    .catch(() => {
                        if (!signal.aborted) failed = true;
                        controller.abort();
                    })
                    .finally(() => {
                        active = undefined;
                    });
            await delay(500, undefined, { signal });
        }
    } catch (error) {
        if (!signal.aborted) throw error;
    } finally {
        controller.abort();
        await active;
        // Do not revoke a newer deployment's heartbeat while the old host shuts down.
        if (heartbeat)
            await options.client`UPDATE mira_integration_receivers SET binding_hash=NULL WHERE key='code:main' AND binding_hash=${localCodeBindingHash(options.binding)} AND heartbeat_at=${heartbeat}::timestamptz`;
    }
    if (failed) throw new Error("Local code host failed.");
}
