import { setTimeout as delay } from "node:timers/promises";

import { miraComputerCommandLimit } from "@homelab/contracts/miraComputerCommands";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import {
    type ComputerCompanion,
    ComputerConnectionError,
    isComputerCancellation,
} from "./companion";
import type { ComputerConsentController } from "./companionConsent";

/** A retryable polling outage raised only when no native operation was admitted by that claim. */
export class ComputerPollingOutage extends ComputerConnectionError {
    /** Create a content-free retry signal; the command loop still awaits controller cleanup before rejection. */
    constructor() {
        super(true);
    }
}

/** A failed read whose controller and native resources have been confirmed closed. */
export class ComputerObservationEnded extends ComputerConnectionError {
    /** Report a retired viewing attempt without treating it as unconfirmed cleanup. */
    constructor() {
        super(true);
    }
}

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
            const command = await options.companion
                .claimCommand(options.credential, binding, signal)
                .catch((error: unknown) => {
                    if (error instanceof ComputerConnectionError && error.retryable)
                        throw new ComputerPollingOutage();
                    throw error;
                });
            signal.throwIfAborted();
            if (!command) {
                await wait(500, signal);
                continue;
            }
            // Never evict: a lost acknowledgement must not permit a later replay in this session.
            if (seen.has(command.commandId) || seen.size >= miraComputerCommandLimit)
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
                        ? await observe(options.controller, operationSignal)
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

async function observe(controller: ComputerConsentController, signal: AbortSignal) {
    try {
        return await controller.observe(signal);
    } catch (error) {
        // Capture errors cannot have sent input. Retire this grant, but keep the
        // paired companion available for a new explicitly approved selection.
        // A failed reap is still terminal and must never permit replacement.
        await closeController(controller);
        if (error instanceof RuntimeCleanupError) throw error;
        if (isComputerCancellation(error, controller.signal)) throw error;
        throw new ComputerObservationEnded();
    }
}

async function closeController(controller: ComputerConsentController): Promise<void> {
    try {
        await controller.close();
    } catch {
        throw new RuntimeCleanupError();
    }
}
