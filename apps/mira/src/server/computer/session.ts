import { randomUUID } from "node:crypto";

import {
    miraComputerInputSchema,
    miraComputerEffectSchema,
} from "@homelab/contracts/miraComputerCommands";
import * as v from "valibot";

import { runtimeContentItems, type RuntimeToolResult } from "../runtime/toolResult";

export interface ComputerObservation {
    snapshot: string;
    width: number;
    height: number;
    content: Exclude<RuntimeToolResult, string>;
}
export type ComputerActionResult = {
    effect: "confirmed" | "partial" | "unverified" | "refused" | "unknown";
};
export interface ComputerWindowPort {
    observe: (signal: AbortSignal) => Promise<ComputerObservation>;
    click: (x: number, y: number, signal: AbortSignal) => Promise<ComputerActionResult>;
    type: (text: string, signal: AbortSignal) => Promise<ComputerActionResult>;
    close: () => Promise<void>;
}
/** A single host-selected window; authorization and desktop readiness come from the host. */
export class ComputerWindowSession {
    private readonly abort = new AbortController();
    private busy = false;
    private stopped = false;
    private closePromise?: Promise<void>;
    private observation:
        | {
              id: string;
              time: number;
              width: number;
              height: number;
          }
        | undefined;

    private readonly port: ComputerWindowPort;
    private readonly assertAvailable: () => Promise<void>;
    private readonly now: () => number;

    /**
     * Bind one driver to a trusted host gate, never to model-selected application names.
     * @param port - Exclusive driver for an already selected native window.
     * @param assertAvailable - Recheck the owner lease, pause state and OS desktop readiness.
     * @param now - Monotonic clock used to expire observations after ten seconds.
     */
    constructor(
        port: ComputerWindowPort,
        assertAvailable: () => Promise<void>,
        now: () => number = () => performance.now()
    ) {
        this.port = port;
        this.assertAvailable = assertAvailable;
        this.now = now;
    }

    /**
     * Read a fresh bounded frame; its random identifier authorizes at most one later input.
     * @param signal - Run cancellation, combined with the host's local stop signal.
     * @returns Inline content and the expiring observation identifier.
     */
    async observe(signal: AbortSignal) {
        this.enter();
        this.observation = undefined;
        const combined = AbortSignal.any([signal, this.abort.signal]);
        try {
            await this.check(combined);
            const frame = await this.port.observe(combined);
            await this.check(combined);
            if (
                !frame.snapshot ||
                !Number.isSafeInteger(frame.width) ||
                !Number.isSafeInteger(frame.height) ||
                frame.width < 1 ||
                frame.height < 1 ||
                frame.width > 8192 ||
                frame.height > 8192
            )
                throw new Error("Computer observation is invalid.");
            const content = runtimeContentItems(frame.content);
            if (content.filter((item) => item.type === "inputImage").length !== 1)
                throw new Error("Computer observation must contain one image.");
            const id = randomUUID();
            this.observation = {
                id,
                time: this.now(),
                width: frame.width,
                height: frame.height,
            };
            return {
                observationId: id,
                width: frame.width,
                height: frame.height,
                ...frame.content,
            };
        } finally {
            this.busy = false;
        }
    }

    /**
     * Deliver one validated input without retrying or upgrading its delivery mode.
     * @param input - Click or literal text against the most recent unused observation.
     * @param signal - Run cancellation; a possibly delivered interruption retires the session.
     * @returns Only an explicit driver outcome, never inferred success from a resolved promise.
     */
    async act(input: unknown, signal: AbortSignal): Promise<ComputerActionResult> {
        const command = v.parse(miraComputerInputSchema, input);
        this.enter();
        const observed = this.observation;
        this.observation = undefined;
        const combined = AbortSignal.any([signal, this.abort.signal]);
        let dispatched = false;
        try {
            await this.check(combined);
            const age = observed ? this.now() - observed.time : -1;
            if (
                !observed ||
                observed.id !== command.observationId ||
                age < 0 ||
                age > 10_000
            )
                throw new Error(
                    "Read a fresh computer observation before sending input."
                );
            if (
                command.action === "click" &&
                (command.x >= observed.width || command.y >= observed.height)
            )
                throw new Error("Computer input is outside the observed window.");
            dispatched = true;
            const result = v.parse(
                miraComputerEffectSchema,
                await (command.action === "click"
                    ? this.port.click(command.x, command.y, combined)
                    : this.port.type(command.text, combined))
            );
            await this.check(combined);
            if (result.effect === "unknown") await this.close();
            return result;
        } catch (error) {
            if (!dispatched) throw error;
            // An interrupted/erroring call may already have reached the OS. Never replay it.
            await this.close().catch(() => {});
            return { effect: "unknown" };
        } finally {
            this.busy = false;
        }
    }

    /**
     * Immediately refuse new work and abort admitted work before releasing the driver.
     * @returns The shared cleanup promise; repeated stop requests never reopen authority.
     */
    close(): Promise<void> {
        this.stopped = true;
        this.observation = undefined;
        this.abort.abort();
        this.closePromise ??= Promise.resolve().then(() => this.port.close());
        return this.closePromise;
    }

    private enter() {
        if (this.stopped) throw new Error("Computer session is stopped.");
        if (this.busy) throw new Error("Computer session already has an active call.");
        this.busy = true;
    }

    private async check(signal: AbortSignal) {
        signal.throwIfAborted();
        await this.assertAvailable();
        signal.throwIfAborted();
        if (this.stopped) throw new Error("Computer session is stopped.");
    }
}
