import {
    startAuthentication,
    startRegistration,
    WebAuthnAbortService,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import * as v from "valibot";

import { IdentityError } from "./IdentityError";
import {
    accountSchema,
    activityPageSchema,
    sessionSchema,
    type AccountSnapshot,
    type ActivityPage,
} from "./schemas";
import { VerificationCoordinator } from "./verificationCoordinator";

export class IdentityClient {
    readonly verification = new VerificationCoordinator();
    #identity: string | undefined;
    #actions = new AbortController();

    #assertActiveAction(signal: AbortSignal): void {
        if (signal.aborted)
            throw new IdentityError("CANCELLED", 0, "The request was cancelled.");
    }

    async #runCeremony<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
        this.#assertActiveAction(signal);
        const cancel = WebAuthnAbortService.cancelCeremony.bind(WebAuthnAbortService);
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const result = await operation();
            this.#assertActiveAction(signal);
            return result;
        } catch (error) {
            this.#assertActiveAction(signal);
            throw error;
        } finally {
            signal.removeEventListener("abort", cancel);
        }
    }

    /**
     * Abort the current action generation and close any shared verification prompt.
     */
    cancelActions(): void {
        this.#actions.abort();
        this.#actions = new AbortController();
        this.verification.cancel();
    }

    /**
     * Send a same-origin JSON request with bounded time and explicit error decoding.
     * @param path - The identity API path.
     * @param input - A POST payload; omitting it selects GET.
     * @param signal - Optional caller cancellation signal.
     * @returns The decoded response, to be schema-validated by the caller.
     */
    async request(path: string, input?: unknown, signal?: AbortSignal): Promise<unknown> {
        try {
            signal?.throwIfAborted();
            const response = await fetch(path, {
                method: input === undefined ? "GET" : "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                cache: "no-store",
                ...(input === undefined ? {} : { body: JSON.stringify(input) }),
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
                    : AbortSignal.timeout(20_000),
            });
            const value: unknown = await response.json();
            if (!response.ok) {
                const result = v.safeParse(
                    v.object({ code: v.string(), message: v.string() }),
                    value
                );
                if (response.status === 401) this.bindIdentity(undefined);
                throw new IdentityError(
                    result.success ? result.output.code : "REQUEST_FAILED",
                    response.status,
                    result.success
                        ? result.output.message
                        : "The request could not be completed."
                );
            }
            return value;
        } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError")
                throw new IdentityError(
                    "TIMEOUT",
                    0,
                    "The server took too long to respond. Check your connection and refresh before trying again."
                );
            if (error instanceof Error && error.name === "AbortError")
                throw new IdentityError("CANCELLED", 0, "The request was cancelled.");
            if (error instanceof TypeError)
                throw new IdentityError(
                    "NETWORK_ERROR",
                    0,
                    "Could not reach the server. Check your connection and refresh before trying again."
                );
            throw error;
        }
    }

    /**
     * Cancel pending actions when their account/session binding changes.
     * @param identity - The current account/session key, or undefined when signed out.
     */
    bindIdentity(identity: string | undefined): void {
        if (this.#identity !== identity) {
            this.cancelActions();
            this.#identity = identity;
        }
    }

    /**
     * Fetch and validate account settings, binding actions to the returned current session.
     * @returns The validated account snapshot.
     */
    async snapshot(): Promise<AccountSnapshot> {
        const snapshot = v.parse(accountSchema, await this.request("/api/account"));
        this.bindIdentity(
            `${snapshot.user.id}:${snapshot.sessions.find((session) => session.current)?.id ?? "missing"}`
        );
        return snapshot;
    }

    /**
     * Read a cancellable page of this account's security events.
     * @param cursor - The server-supplied continuation token, or null for the newest page.
     * @param signal - Cancellation tied to the current list query.
     * @returns Validated redacted events and the next page boundary.
     */
    async activity(cursor: string | null, signal?: AbortSignal): Promise<ActivityPage> {
        return v.parse(
            activityPageSchema,
            await this.request(
                `/api/account/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
                undefined,
                signal
            )
        );
    }

    /**
     * Read the current central session without marking background polling as activity.
     * @returns The validated session and available verification methods.
     */
    async session() {
        return v.parse(sessionSchema, await this.request("/api/session"));
    }

    /**
     * Run an account mutation and retry once after shared step-up if its identity is unchanged.
     * @param path - The account action path below /api/account/.
     * @param input - The JSON action payload.
     * @param signal - Optional cancellation tied to the caller's operation.
     * @returns The decoded action response.
     */
    async action(
        path: string,
        input: unknown = {},
        signal?: AbortSignal
    ): Promise<unknown> {
        signal = AbortSignal.any([this.#actions.signal, ...(signal ? [signal] : [])]);
        const identity = this.#identity;
        try {
            return await this.request(`/api/account/${path}`, input, signal);
        } catch (error) {
            if (
                !(error instanceof IdentityError) ||
                error.code !== "STEP_UP_REQUIRED" ||
                !identity
            )
                throw error;
            const accepted = await this.verification.request(signal);
            if (!accepted || signal?.aborted || this.#identity !== identity)
                throw new IdentityError(
                    "CANCELLED",
                    0,
                    "Security verification was cancelled."
                );
            // One replay, and only after an explicit pre-mutation rejection. Network
            // errors and ambiguous outcomes are never automatically resubmitted.
            return this.request(`/api/account/${path}`, input, signal);
        }
    }

    /**
     * Complete a browser WebAuthn proof bound to the current action generation.
     * @returns Completion after the server verifies the assertion.
     */
    async securityKeyProof(): Promise<void> {
        const signal = this.#actions.signal;
        const value = v.parse(
            v.object({ token: v.string(), options: v.record(v.string(), v.unknown()) }),
            await this.request("/api/account/proof/webauthn/begin", {}, signal)
        );
        this.#assertActiveAction(signal);
        const response = await this.#runCeremony(signal, () =>
            startAuthentication({
                optionsJSON:
                    value.options as unknown as PublicKeyCredentialRequestOptionsJSON,
            })
        );
        await this.request(
            "/api/account/proof/webauthn/finish",
            {
                token: value.token,
                response,
            },
            signal
        );
    }

    /**
     * Register a security key without allowing a canceled ceremony to mutate the account.
     * @param label - The display name for the new authenticator.
     * @returns New recovery codes, if this enrollment creates them.
     */
    async enrollSecurityKey(label: string): Promise<string[]> {
        const signal = this.#actions.signal;
        const value = v.parse(
            v.object({ token: v.string(), options: v.record(v.string(), v.unknown()) }),
            await this.action("webauthn/begin", {}, signal)
        );
        this.#assertActiveAction(signal);
        const response = await this.#runCeremony(signal, () =>
            startRegistration({
                optionsJSON:
                    value.options as unknown as PublicKeyCredentialCreationOptionsJSON,
            })
        );
        return v.parse(
            v.object({ recoveryCodes: v.array(v.string()) }),
            await this.action(
                "webauthn/finish",
                { token: value.token, label, response },
                signal
            )
        ).recoveryCodes;
    }
}
