import {
    miraComputerEnrollmentSchema,
    miraComputerAccessAcceptSchema,
    miraComputerAccessPermitSchema,
    type MiraComputerAccessSummary,
    type MiraComputerConsentRequest,
} from "@homelab/contracts/miraComputers";
import * as v from "valibot";

import { readComputerCredential } from "./credentials";

const uuid = v.pipe(v.string(), v.uuid());
const enrollment = v.strictObject({
    id: uuid,
    credential: v.string(),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    controlAllowed: v.literal(false),
});
const connection = v.strictObject({
    connectionId: uuid,
    heartbeatSeconds: v.literal(15),
    leaseSeconds: v.literal(45),
    controlAllowed: v.literal(false),
});
const heartbeat = v.strictObject({
    leaseSeconds: v.literal(45),
    controlAllowed: v.literal(false),
});
const accessSummary = v.strictObject({
    id: uuid,
    computerId: uuid,
    runId: uuid,
    mode: v.picklist(["view", "control"]),
    state: v.picklist(["pending", "active"]),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
});
export const computerConsentRequestSchema = v.strictObject({
    ...accessSummary.entries,
    state: v.literal("pending"),
    consentExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
});
const permit = v.strictObject({
    ...miraComputerAccessPermitSchema.entries,
    validForMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5000)),
});
export type ComputerAccessPermit = v.InferOutput<typeof permit>;
export type ComputerEnrollment = v.InferOutput<typeof enrollment>;
export type ComputerFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** A content-free failure that distinguishes temporary outages from rejected credentials. */
export class ComputerConnectionError extends Error {
    readonly retryable: boolean;

    /**
     * Create a public connection failure without retaining remote bodies or credentials.
     * @param retryable - Whether an established client may reconnect after a delay.
     */
    constructor(retryable: boolean) {
        super(
            retryable
                ? "The computer connection is unavailable. Try again shortly."
                : "The computer connection was rejected. Check the server and pairing in Settings."
        );
        this.retryable = retryable;
    }
}

/** A transport request cancelled by its caller, without remote error bodies or credentials. */
export class ComputerRequestCancelledError extends ComputerConnectionError {
    private readonly stopped: AbortSignal;
    /**
     * Retain the exact local cancellation source rather than inferring it from later controller state.
     * @param stopped - The caller signal already aborted when the request was cancelled.
     */
    constructor(stopped: AbortSignal) {
        super(false);
        this.stopped = stopped;
    }
    /**
     * Match cancellation to its original caller, never another already-retired controller.
     * @param signal - The local lifetime being checked.
     * @returns Whether this exact caller cancelled the request.
     */
    cancelledBy(signal: AbortSignal): boolean {
        return signal.aborted && signal === this.stopped;
    }
}

/**
 * Identify an expected cancellation without hiding unrelated failures after a signal was aborted.
 * @param error - Transport cancellation, exact abort reason or the timers API's wrapped abort reason.
 * @param signal - The specific lifetime that must have caused cancellation.
 * @returns True only for cancellation tied to this already-aborted signal.
 */
export function isComputerCancellation(error: unknown, signal: AbortSignal): boolean {
    return (
        signal.aborted &&
        (error === signal.reason ||
            (error instanceof ComputerRequestCancelledError &&
                error.cancelledBy(signal)) ||
            (error instanceof Error &&
                error.name === "AbortError" &&
                error.cause === signal.reason))
    );
}

/**
 * Validate an explicit HTTPS dashboard origin before any credential is read or sent.
 * @param input - Operator-supplied origin, without path, credentials, query or fragment.
 * @returns Canonical HTTPS origin, also used to scope local credential storage.
 */
export function computerOrigin(input: string): string {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new Error("Enter an HTTPS dashboard origin.");
    }
    if (
        input.length > 512 ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        /[\s\\]/u.test(input)
    )
        throw new Error(
            "Enter an HTTPS dashboard origin without a path or sign-in details."
        );
    return url.origin;
}

/**
 * Send a machine request with certificate verification and no environment-selected proxy.
 * @param url - Validated, fixed-path HTTPS destination.
 * @param init - Bounded request with explicit redirect and credential policies.
 * @returns The native response; its body remains subject to the caller's bound and deadline.
 */
export function fetchComputer(url: URL, init: RequestInit): Promise<Response> {
    return fetch(url, { ...init, tls: { rejectUnauthorized: true }, proxy: false });
}

/** Outbound pairing, presence and consent transport; it never receives native targets or input commands. */
export class ComputerCompanion {
    readonly origin: string;
    private readonly request: ComputerFetch;

    /**
     * Bind all future calls to a single operator-selected HTTPS origin.
     * @param origin - Dashboard origin; redirects and alternate endpoints are never followed.
     * @param request - Native transport by default; injectable for disposable qualification.
     */
    constructor(origin: string, request: ComputerFetch = fetchComputer) {
        this.origin = computerOrigin(origin);
        this.request = request;
    }

    /**
     * Consume one short-lived ticket exactly once, without automatic network retries.
     * @param token - Ticket entered privately by the operator.
     * @param metadata - Local installation metadata, not a device attestation.
     * @param signal - Local cancellation, including terminal stop.
     * @returns Validated credential to save in the OS credential store.
     */
    async enroll(
        token: string,
        metadata: unknown,
        signal: AbortSignal
    ): Promise<ComputerEnrollment> {
        const parsed = readComputerCredential(token, "pair");
        if (!parsed) throw new ComputerConnectionError(false);
        const input = v.parse(miraComputerEnrollmentSchema, metadata);
        const parsedResult = v.safeParse(
            enrollment,
            await this.send("enroll", token, input, signal)
        );
        if (!parsedResult.success) throw new ComputerConnectionError(false);
        const result = parsedResult.output;
        const credential = readComputerCredential(result.credential, "device");
        if (
            result.id !== parsed.id ||
            credential?.id !== result.id ||
            Date.parse(result.expiresAt) <= Date.now()
        )
            throw new ComputerConnectionError(false);
        return result;
    }

    /**
     * Create a fresh generation; the server invalidates any older connection.
     * @param token - Computer-only credential from the scoped OS store.
     * @param signal - Local cancellation.
     * @returns Validated generation and fixed heartbeat cadence.
     */
    async connect(token: string, signal: AbortSignal) {
        if (!readComputerCredential(token, "device"))
            throw new ComputerConnectionError(false);
        const result = v.safeParse(
            connection,
            await this.send("connect", token, {}, signal)
        );
        if (!result.success) throw new ComputerConnectionError(false);
        return result.output;
    }

    /**
     * Renew only the current generation with a strictly increasing sequence number.
     * @param token - Computer-only credential; never included in the JSON body.
     * @param connectionId - Server-issued generation.
     * @param sequence - Increasing positive sequence for this connection.
     * @param signal - Local cancellation.
     * @returns Completion after a bounded, validated presence receipt.
     */
    async heartbeat(
        token: string,
        connectionId: string,
        sequence: number,
        signal: AbortSignal
    ): Promise<void> {
        if (
            !readComputerCredential(token, "device") ||
            !v.is(uuid, connectionId) ||
            !Number.isInteger(sequence) ||
            sequence < 1 ||
            sequence > 2_147_483_647
        )
            throw new ComputerConnectionError(false);
        if (
            !v.is(
                heartbeat,
                await this.send("heartbeat", token, { connectionId, sequence }, signal)
            )
        )
            throw new ComputerConnectionError(false);
    }

    /**
     * Read the one pending local consent request for this connection.
     * @param token - OS-vault device credential.
     * @param connectionId - Exact current generation.
     * @param signal - Local cancellation, including connection retirement.
     * @returns Metadata only; a request never enables screen or input access.
     */
    async pendingAccess(
        token: string,
        connectionId: string,
        signal: AbortSignal
    ): Promise<MiraComputerConsentRequest | null> {
        const device = readComputerCredential(token, "device");
        if (!device || !v.is(uuid, connectionId))
            throw new ComputerConnectionError(false);
        const result = v.safeParse(
            v.strictObject({ request: v.nullable(computerConsentRequestSchema) }),
            await this.send("access/pending", token, { connectionId }, signal)
        );
        if (!result.success) throw new ComputerConnectionError(false);
        const request = result.output.request;
        if (
            request &&
            (request.computerId !== device.id ||
                request.state !== "pending" ||
                Date.parse(request.consentExpiresAt) <= Date.now() ||
                Date.parse(request.consentExpiresAt) > Date.parse(request.expiresAt) ||
                Date.parse(request.expiresAt) <= Date.now())
        )
            throw new ComputerConnectionError(false);
        return request;
    }

    /**
     * Accept one request after the PC's local user has selected an immutable target.
     * @param token - OS-vault credential; no executable, PID or window title is sent.
     * @param input - Exact request/generation and a newly generated opaque target ID.
     * @param signal - Local cancellation; acceptance is never automatically retried.
     * @returns The active receipt; uncertain delivery requires stop and new consent.
     */
    async acceptAccess(
        token: string,
        input: v.InferInput<typeof miraComputerAccessAcceptSchema>,
        signal: AbortSignal
    ): Promise<MiraComputerAccessSummary> {
        const device = readComputerCredential(token, "device");
        if (!device) throw new ComputerConnectionError(false);
        const request = v.parse(miraComputerAccessAcceptSchema, input);
        const result = v.safeParse(
            accessSummary,
            await this.send("access/accept", token, request, signal)
        );
        if (
            !result.success ||
            result.output.id !== request.id ||
            result.output.computerId !== device.id ||
            result.output.state !== "active" ||
            Date.parse(result.output.expiresAt) <= Date.now()
        )
            throw new ComputerConnectionError(false);
        return result.output;
    }

    /**
     * Revalidate the current consent without renewing its absolute lifetime.
     * @param token - Device credential, scoped to the fixed private origin.
     * @param input - Exact immutable session binding and required action scope.
     * @param signal - Local stop; callers measure freshness from request start.
     * @returns A maximum five-second dispatch ceiling, never an independent bearer capability.
     */
    async permitAccess(
        token: string,
        input: v.InferInput<typeof miraComputerAccessPermitSchema>,
        signal: AbortSignal
    ): Promise<ComputerAccessPermit> {
        if (!readComputerCredential(token, "device"))
            throw new ComputerConnectionError(false);
        const request = v.parse(miraComputerAccessPermitSchema, input);
        const result = v.safeParse(
            permit,
            await this.send("access/permit", token, request, signal)
        );
        if (
            !result.success ||
            result.output.id !== request.id ||
            result.output.connectionId !== request.connectionId ||
            result.output.targetId !== request.targetId ||
            (request.mode === "control" && result.output.mode !== "control")
        )
            throw new ComputerConnectionError(false);
        return result.output;
    }

    /**
     * Record local rejection or stop after the native controller has already been retired.
     * @param token - Device credential; the old generation need not still be live.
     * @param id - Exact consent request to stop, with no effect on other computers.
     * @param signal - Bounded cleanup; failure never restores local authority.
     * @returns Confirmation of an idempotent server stop.
     */
    async stopAccess(token: string, id: string, signal: AbortSignal): Promise<void> {
        if (!readComputerCredential(token, "device") || !v.is(uuid, id))
            throw new ComputerConnectionError(false);
        if (
            !v.is(
                v.strictObject({ stopped: v.literal(true) }),
                await this.send("access/stop", token, { id }, signal)
            )
        )
            throw new ComputerConnectionError(false);
    }

    private async send(
        route:
            | "enroll"
            | "connect"
            | "heartbeat"
            | "access/pending"
            | "access/accept"
            | "access/permit"
            | "access/stop",
        token: string,
        body: unknown,
        stopped: AbortSignal
    ): Promise<unknown> {
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), 10_000);
        const signal = AbortSignal.any([stopped, deadline.signal]);
        let response: Response | undefined;
        let reader:
            | Pick<
                  ReadableStreamDefaultReader<Uint8Array>,
                  "read" | "cancel" | "releaseLock"
              >
            | undefined;
        const abortRead = () => {
            void reader?.cancel().catch(() => null);
        };
        signal.addEventListener("abort", abortRead, { once: true });
        try {
            signal.throwIfAborted();
            response = await this.request(
                new URL(`/api/mira/computers/${route}`, this.origin),
                {
                    method: "POST",
                    redirect: "error",
                    credentials: "omit",
                    cache: "no-store",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify(body),
                    signal,
                }
            );
            if (
                response.redirected ||
                (response.url && new URL(response.url).origin !== this.origin)
            )
                throw new ComputerConnectionError(false);
            if (!response.ok)
                throw new ComputerConnectionError(
                    response.status === 429 || response.status >= 500
                );
            if (
                response.headers.get("content-type")?.split(";")[0]?.trim() !==
                    "application/json" ||
                !response.body
            )
                throw new ComputerConnectionError(false);
            reader = response.body.getReader();
            let size = 0;
            const chunks: Uint8Array[] = [];
            while (true) {
                const next = await reader.read();
                signal.throwIfAborted();
                if (next.done) break;
                size += next.value.length;
                if (size > 4096) throw new ComputerConnectionError(false);
                chunks.push(next.value);
            }
            return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch (error) {
            if (stopped.aborted) throw new ComputerRequestCancelledError(stopped);
            if (error instanceof ComputerConnectionError) throw error;
            throw new ComputerConnectionError(!(error instanceof SyntaxError));
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abortRead);
            if (reader) {
                await reader.cancel().catch(() => null);
                reader.releaseLock();
            } else await response?.body?.cancel().catch(() => null);
        }
    }
}
