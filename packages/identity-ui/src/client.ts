import {
    startAuthentication,
    startRegistration,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import * as v from "valibot";

import { VerificationCoordinator } from "./verificationCoordinator";

const date = v.string();
export const accountSchema = v.object({
    user: v.object({
        id: v.string(),
        username: v.string(),
        email: v.string(),
        emailVerified: v.boolean(),
    }),
    factors: v.array(
        v.object({
            id: v.string(),
            kind: v.picklist(["totp", "webauthn"]),
            label: v.string(),
            createdAt: date,
            lastUsedAt: v.nullable(date),
        })
    ),
    recoveryCodesRemaining: v.number(),
    sessions: v.array(
        v.object({
            id: v.string(),
            userAgent: v.string(),
            createdAt: date,
            lastSeenAt: date,
            expiresAt: date,
            current: v.boolean(),
        })
    ),
    events: v.array(v.object({ id: v.string(), event: v.string(), createdAt: date })),
});
export type AccountSnapshot = v.InferOutput<typeof accountSchema>;
const sessionSchema = v.object({
    authenticated: v.boolean(),
    mfaRequired: v.boolean(),
    methods: v.array(v.picklist(["totp", "webauthn"])),
    username: v.optional(v.string()),
});
export class IdentityError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
        super(message);
        this.name = "IdentityError";
        this.code = code;
        this.status = status;
    }
}

export class IdentityClient {
    readonly verification = new VerificationCoordinator();
    #identity: string | undefined;
    #actions = new AbortController();

    cancelActions(): void {
        this.#actions.abort();
        this.#actions = new AbortController();
        this.verification.cancel();
    }

    async request(path: string, input?: unknown, signal?: AbortSignal): Promise<unknown> {
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
    }

    bindIdentity(identity: string | undefined): void {
        if (this.#identity !== identity) {
            this.cancelActions();
            this.#identity = identity;
        }
    }

    async snapshot(): Promise<AccountSnapshot> {
        const snapshot = v.parse(accountSchema, await this.request("/api/account"));
        this.bindIdentity(
            `${snapshot.user.id}:${snapshot.sessions.find((session) => session.current)?.id ?? "missing"}`
        );
        return snapshot;
    }

    async session() {
        return v.parse(sessionSchema, await this.request("/api/session"));
    }

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

    async securityKeyProof(): Promise<void> {
        const value = v.parse(
            v.object({ token: v.string(), options: v.record(v.string(), v.unknown()) }),
            await this.request("/api/account/proof/webauthn/begin", {})
        );
        const response = await startAuthentication({
            optionsJSON:
                value.options as unknown as PublicKeyCredentialRequestOptionsJSON,
        });
        await this.request("/api/account/proof/webauthn/finish", {
            token: value.token,
            response,
        });
    }

    async enrollSecurityKey(label: string): Promise<string[]> {
        const value = v.parse(
            v.object({ token: v.string(), options: v.record(v.string(), v.unknown()) }),
            await this.action("webauthn/begin")
        );
        const response = await startRegistration({
            optionsJSON:
                value.options as unknown as PublicKeyCredentialCreationOptionsJSON,
        });
        return v.parse(
            v.object({ recoveryCodes: v.array(v.string()) }),
            await this.action("webauthn/finish", { token: value.token, label, response })
        ).recoveryCodes;
    }
}
