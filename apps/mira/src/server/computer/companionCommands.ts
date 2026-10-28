import { setTimeout as delay } from "node:timers/promises";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import {
    ComputerConnectionError,
    isComputerCancellation,
    type ComputerCompanion,
} from "./companion";
import type { ComputerConsentController } from "./companionConsent";

/**
 * Deliver sequential one-time commands only inside an already accepted local controller.
 * @param options - Fixed private transport, credential and consented controller; no host factory or retry hook.
 * @returns Completion after cancellation and confirmed controller cleanup; failures block replacement.
 */
export async function runComputerCommandLoop(options: {
    companion: Pick<ComputerCompanion, "claimCommand" | "finishCommand">;
    credential: string;
    controller: ComputerConsentController;
    signal: AbortSignal;
    now?: () => number;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
    const now = options.now ?? (() => performance.now());
    const wait =
        options.wait ??
        ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
    const signal = AbortSignal.any([options.signal, options.controller.signal]);
    const seen = new Set<string>();
    try {
        signal.throwIfAborted();
        const binding = options.controller.commandBinding();
        while (!signal.aborted) {
            const started = now();
            const command = await options.companion.claimCommand(
                options.credential,
                binding,
                signal
            );
            signal.throwIfAborted();
            if (!command) {
                await wait(500, signal);
                continue;
            }
            // Never evict: a lost acknowledgement must not permit a later replay in this session.
            if (seen.has(command.commandId) || seen.size >= 1024)
                throw new ComputerConnectionError(false);
            seen.add(command.commandId);
            const until = started + command.validForMs;
            const remaining = until - now();
            if (now() < started || remaining <= 0)
                throw new ComputerConnectionError(false);
            const deadline = new AbortController();
            const timer = setTimeout(() => deadline.abort(), remaining);
            const operationSignal = AbortSignal.any([signal, deadline.signal]);
            try {
                const result =
                    command.operation.action === "observe"
                        ? await options.controller.observe(operationSignal)
                        : await options.controller.act(
                              command.operation,
                              operationSignal
                          );
                operationSignal.throwIfAborted();
                if (now() < started || now() >= until)
                    throw new ComputerConnectionError(false);
                await options.companion.finishCommand(
                    options.credential,
                    command,
                    result,
                    operationSignal
                );
                operationSignal.throwIfAborted();
            } finally {
                clearTimeout(timer);
            }
        }
    } catch (error) {
        if (!isComputerCancellation(error, signal)) throw error;
    } finally {
        await closeController(options.controller);
    }
}

async function closeController(controller: ComputerConsentController): Promise<void> {
    try {
        await controller.close();
    } catch {
        throw new RuntimeCleanupError();
    }
}
