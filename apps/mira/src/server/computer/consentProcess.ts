import path from "node:path";

import type { MiraComputerConsentRequest } from "@homelab/contracts/miraComputers";
import * as v from "valibot";

import { RpcProcess, type RpcProcessOptions } from "../runtime/rpcProcess";
import { computerConsentRequestSchema, computerOrigin } from "./companion";
import { computerWindowGrant, type ComputerWindowGrant } from "./policy";
import { computerChildEnvironment } from "./process";

/** A local consent surface; its pipe never receives credentials, pixels or input commands. */
export interface ComputerConsentSurface {
    signal: AbortSignal;
    target: Readonly<ComputerWindowGrant & { mode: MiraComputerConsentRequest["mode"] }>;
    /**
     * Recheck the selected window and independently observed interactive desktop state.
     * @returns Completion only while the same local selection remains available.
     */
    assertReady(): Promise<void>;
    /**
     * Retire the UI and reap its process before any replacement is admitted.
     * @returns Completion after the actual native host process has exited.
     */
    close(): Promise<void>;
}

/**
 * Obtain one explicit selection from a fixed, packaged local consent host.
 * @param options - Host-owned executable/arguments/environment, exact request, origin and permanent stop.
 * @returns An immutable target and readiness gate, or null after local refusal. No driver is opened here.
 */
export async function openComputerConsentSurface(
    options: Pick<RpcProcessOptions, "command" | "args" | "cwd" | "windowsHide"> & {
        environment: Record<string, string>;
        request: MiraComputerConsentRequest;
        origin: string;
        signal: AbortSignal;
    }
): Promise<ComputerConsentSurface | null> {
    if (!path.isAbsolute(options.command) || !path.isAbsolute(options.cwd))
        throw new Error("Local computer consent requires packaged absolute paths.");
    const request = v.parse(computerConsentRequestSchema, options.request);
    const origin = computerOrigin(options.origin);
    const remaining = Math.min(
        60_000,
        Date.parse(request.consentExpiresAt) - Date.now(),
        Date.parse(request.expiresAt) - Date.now()
    );
    if (!Number.isFinite(remaining) || remaining <= 0)
        throw new Error("Computer consent expired.");
    const stopped = new AbortController();
    const signal = AbortSignal.any([options.signal, stopped.signal]);
    let resolveSelection!: (target: ComputerConsentSurface["target"] | null) => void;
    const selection = new Promise<ComputerConsentSurface["target"] | null>((resolve) => {
        resolveSelection = resolve;
    });
    const connection = new RpcProcess({
        command: options.command,
        windowsHide: options.windowsHide ?? false,
        args: [...options.args],
        cwd: options.cwd,
        env: computerChildEnvironment(options.environment),
        signal,
        requestTimeoutMs: 2000,
        maxFrameBytes: 8192,
        onRequest: () => {
            stopped.abort();
            return Promise.reject(new Error("Local consent cannot call host tools."));
        },
    });
    let selected = false;
    let refused = false;
    const ended = () => resolveSelection(null);
    connection.signal.addEventListener("abort", ended, { once: true });
    const unsubscribe = connection.subscribe((event) => {
        if (event.method === "consent/stopped") {
            v.parse(v.strictObject({}), event.params);
            refused = true;
            resolveSelection(null);
            stopped.abort();
        } else if (event.method === "consent/selected" && !selected && !signal.aborted) {
            const parsed = v.parse(v.strictObject({ target: v.unknown() }), event.params);
            const target = computerWindowGrant(parsed.target);
            if (target.delivery !== "foreground" || target.mode !== undefined)
                throw new Error("Unexpected local consent target scope.");
            selected = true;
            resolveSelection(Object.freeze({ ...target, mode: request.mode }));
        } else throw new Error("Unexpected local consent message.");
    });
    const timer = setTimeout(() => stopped.abort(), remaining);
    const close = async () => {
        stopped.abort();
        clearTimeout(timer);
        unsubscribe();
        connection.signal.removeEventListener("abort", ended);
        await connection.close();
    };
    try {
        v.parse(
            v.strictObject({ protocol: v.literal(1) }),
            await connection.request("initialize", {
                id: request.id,
                runId: request.runId,
                origin,
                mode: request.mode,
                consentExpiresAt: request.consentExpiresAt,
                expiresAt: request.expiresAt,
            })
        );
        const target = await selection;
        if (!target || refused) {
            await close();
            return null;
        }
        signal.throwIfAborted();
        connection.signal.throwIfAborted();
        clearTimeout(timer);
        const assertReady = async () => {
            try {
                signal.throwIfAborted();
                connection.signal.throwIfAborted();
                v.parse(
                    v.strictObject({ ready: v.literal(true) }),
                    await connection.request("check", {})
                );
                signal.throwIfAborted();
                connection.signal.throwIfAborted();
            } catch {
                await close();
                throw new Error(
                    "The local desktop or selected window is no longer available."
                );
            }
        };
        await assertReady();
        return { target, signal: connection.signal, assertReady, close };
    } catch (error) {
        await close();
        throw error;
    }
}
