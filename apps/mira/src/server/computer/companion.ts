import { miraComputerEnrollmentSchema } from "@homelab/contracts/miraComputers";
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

/** Outbound pairing and presence transport; it has no screen or input methods. */
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

    private async send(
        route: "enroll" | "connect" | "heartbeat",
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
            if (stopped.aborted) throw new ComputerConnectionError(false);
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
