import type { MiraComputerConsentRequest } from "@homelab/contracts/miraComputers";
import * as v from "valibot";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import { computerConsentRequestSchema, computerOrigin } from "./companion";
import type { ComputerConsentHost } from "./companionConsent";
import {
    openComputerConsentSurface,
    type ComputerConsentSurface,
} from "./consentProcess";
import { computerWindowGrant, type ComputerWindowGrant } from "./policy";
import type { ComputerWindowPort } from "./session";

type SurfaceOptions = Parameters<typeof openComputerConsentSurface>[0];
type Target = ComputerConsentSurface["target"];

/** One local consent surface bound to one supervised driver factory and connection. */
export class ComputerLocalConsentHost implements ComputerConsentHost {
    private readonly abort = new AbortController();
    readonly signal = this.abort.signal;
    private readonly options: Omit<SurfaceOptions, "request" | "signal">;
    private readonly openDriver: (
        target: Target,
        signal: AbortSignal
    ) => Promise<ComputerWindowPort>;
    private readonly openSurface: typeof openComputerConsentSurface;
    private selecting?: Promise<ComputerConsentSurface | null>;
    private surface?: ComputerConsentSurface;
    private target?: Target;
    private attempted = false;
    private opened = false;
    private opening?: Promise<ComputerWindowPort>;
    private closing?: Promise<void>;
    private startupCleanupFailure?: RuntimeCleanupError;
    private detach?: () => void;
    private readonly stop = () => {
        void this.close().catch(() => {});
    };

    /**
     * Bind trusted packaged host configuration; no caller can supply remote paths or native targets.
     * @param options - Fixed consent host paths/environment and canonical private server origin.
     * @param openDriver - Qualified supervisor for one immutable target; it owns startup failure cleanup.
     * @param openSurface - Local process transport, injectable for isolated lifecycle qualification.
     */
    constructor(
        options: Omit<SurfaceOptions, "request" | "signal">,
        openDriver: ComputerLocalConsentHost["openDriver"],
        openSurface: typeof openComputerConsentSurface = openComputerConsentSurface
    ) {
        this.options = {
            ...options,
            origin: computerOrigin(options.origin),
            args: [...options.args],
            environment: { ...options.environment },
        };
        this.openDriver = openDriver;
        this.openSurface = openSurface;
    }

    /**
     * Show one request and retain its native monitor until permanent retirement.
     * @param request - Original job, view/control scope and deadlines from the authenticated server.
     * @param signal - Controller retirement, including connection loss or expired consent.
     * @returns A frozen local target, or null after refusal; late selection never restores access.
     */
    async select(
        request: Readonly<MiraComputerConsentRequest>,
        signal: AbortSignal
    ): Promise<Target | null> {
        this.signal.throwIfAborted();
        signal.throwIfAborted();
        if (this.attempted) throw new Error("Local consent was already requested.");
        this.attempted = true;
        const shown = Object.freeze(v.parse(computerConsentRequestSchema, request));
        signal.addEventListener("abort", this.stop, { once: true });
        this.detach = () => signal.removeEventListener("abort", this.stop);
        const combined = AbortSignal.any([signal, this.signal]);
        this.selecting = Promise.resolve()
            .then(() => {
                combined.throwIfAborted();
                return this.openSurface({
                    ...this.options,
                    request: shown,
                    signal: combined,
                });
            })
            .catch((error: unknown) => {
                if (error instanceof RuntimeCleanupError)
                    this.startupCleanupFailure = error;
                throw error;
            });
        try {
            const surface = await this.selecting;
            if (!surface) {
                await this.close();
                return null;
            }
            this.surface = surface;
            surface.signal.addEventListener("abort", this.stop, { once: true });
            if (surface.signal.aborted) this.stop();
            combined.throwIfAborted();
            const target = computerWindowGrant(surface.target);
            if (target.mode !== shown.mode)
                throw new Error("Local consent scope changed.");
            this.target = Object.freeze({ ...target, mode: shown.mode });
            await this.assertReady(this.target, combined);
            return this.target;
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    /**
     * Check the exact immutable selection and the native host's independent readiness monitor.
     * @param target - Controller-owned copy of the selected target; every field must still match.
     * @param signal - Controller or short permit retirement; failure permanently closes the host.
     * @returns Completion only while the same local authority remains live.
     */
    async assertReady(
        target: Readonly<ComputerWindowGrant>,
        signal: AbortSignal
    ): Promise<void> {
        try {
            this.assertTarget(target, signal);
            await this.surface!.assertReady();
            this.assertTarget(target, signal);
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    /**
     * Start one supervised driver after consent, bound to the frozen local mode and target.
     * @param target - Exact controller copy; executable, process, window or scope overrides are refused.
     * @param signal - Controller retirement; combined with permanent local stop for the driver lifetime.
     * @returns A port owned by the controller; a late starting port is closed before returning an error.
     */
    async open(
        target: Readonly<ComputerWindowGrant>,
        signal: AbortSignal
    ): Promise<ComputerWindowPort> {
        if (this.opened) throw new Error("Local computer driver was already opened.");
        this.opened = true;
        try {
            await this.assertReady(target, signal);
            const combined = AbortSignal.any([signal, this.signal]);
            combined.throwIfAborted();
            this.opening = Promise.resolve()
                .then(async () => {
                    combined.throwIfAborted();
                    const port = await this.openDriver(this.target!, combined);
                    let closing: Promise<void> | undefined;
                    return {
                        observe: (signal: AbortSignal) => port.observe(signal),
                        click: (x: number, y: number, signal: AbortSignal) =>
                            port.click(x, y, signal),
                        type: (text: string, signal: AbortSignal) =>
                            port.type(text, signal),
                        close: () =>
                            (closing ??= Promise.resolve().then(() => port.close())),
                    };
                })
                .catch((error: unknown) => {
                    if (error instanceof RuntimeCleanupError)
                        this.startupCleanupFailure = error;
                    throw error;
                });
            const port = await this.opening;
            await this.assertReady(target, combined);
            return port;
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    /**
     * Abort immediately and wait for the native driver and consent surface, including late startups.
     * @returns Shared cleanup; errors remain visible to the controller and block replacement.
     */
    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = Promise.resolve().then(() => this.cleanup());
        this.abort.abort();
        this.detach?.();
        return this.closing;
    }

    private async cleanup(): Promise<void> {
        const results = await Promise.allSettled([
            (async () => {
                const surface = await this.selecting?.catch(() => null);
                surface?.signal.removeEventListener("abort", this.stop);
                await surface?.close();
            })(),
            (async () => {
                const port = await this.opening?.catch(() => null);
                await port?.close();
            })(),
        ]);
        if (this.startupCleanupFailure) throw this.startupCleanupFailure;
        if (results.some((result) => result.status === "rejected"))
            throw new Error("Local computer cleanup could not be confirmed.");
    }

    private assertTarget(target: Readonly<ComputerWindowGrant>, signal: AbortSignal) {
        this.signal.throwIfAborted();
        signal.throwIfAborted();
        this.surface?.signal.throwIfAborted();
        const parsed = computerWindowGrant(target);
        if (
            !this.surface ||
            !this.target ||
            parsed.executable !== this.target.executable ||
            parsed.pid !== this.target.pid ||
            parsed.windowId !== this.target.windowId ||
            parsed.delivery !== this.target.delivery ||
            parsed.mode !== this.target.mode
        )
            throw new Error("Local consent target changed.");
    }
}
