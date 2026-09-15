import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type AuthenticationResponseJSON,
    type AuthenticatorTransport,
    type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { TOTP, Secret } from "otpauth";
import * as v from "valibot";

import type { AuthStore } from "../database/connection";
import { factors, recoveryCodes, sessions, users } from "../database/schema";
import { type Accounts, type Principal } from "./accounts";
import { decryptValue, encryptValue, randomToken, tokenDigest } from "./crypto";
import { AuthFailure, invalidProof } from "./errors";
import { audit, createChallenge, rateLimit, takeChallenge } from "./store";

const totpDataSchema = v.object({ secret: v.string() });
const webauthnDataSchema = v.object({
    publicKey: v.string(),
    transports: v.array(v.string()),
});
const originChallengeSchema = v.object({ challenge: v.string(), origin: v.string() });
const factorLimit = 8;

export class MultiFactor {
    readonly accounts: Accounts;
    constructor(accounts: Accounts) {
        this.accounts = accounts;
    }

    async methods(principal: Principal) {
        const inventory = await this.accounts.database
            .select({ kind: factors.kind })
            .from(factors)
            .where(eq(factors.userId, principal.user.id));
        return [...new Set(inventory.map((factor) => factor.kind))];
    }

    async hasRecoveryCodes(principal: Principal): Promise<boolean> {
        const [code] = await this.accounts.database
            .select({ digest: recoveryCodes.digest })
            .from(recoveryCodes)
            .where(eq(recoveryCodes.userId, principal.user.id))
            .limit(1);
        return code !== undefined;
    }

    async newRecoveryCodes(store: AuthStore, userId: string): Promise<string[]> {
        const codes = Array.from({ length: 10 }, () => randomToken().slice(0, 20));
        await store.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
        await store
            .insert(recoveryCodes)
            .values(codes.map((code) => ({ userId, digest: tokenDigest(code) })));
        return codes;
    }

    async finishEnrollment(store: AuthStore, principal: Principal, wasEnabled: boolean) {
        await this.accounts.completeMfa(store, principal);
        if (wasEnabled) return { recoveryCodes: [] };
        await this.accounts.revokeOthers(store, principal);
        return { recoveryCodes: await this.newRecoveryCodes(store, principal.user.id) };
    }

    async ensureRoom(store: AuthStore, userId: string): Promise<void> {
        const inventory = await store
            .select({ id: factors.id })
            .from(factors)
            .where(eq(factors.userId, userId));
        if (inventory.length >= factorLimit)
            throw new AuthFailure(
                "FACTOR_LIMIT",
                409,
                "Remove an unused security method first."
            );
    }

    async beginTotp(principal: Principal, label: string) {
        return this.accounts.protectedAction(principal, async (transaction) => {
            await this.ensureRoom(transaction, principal.user.id);
            const totp = new TOTP({
                issuer: "Homelab",
                label: principal.user.username,
                algorithm: "SHA1",
                digits: 6,
                period: 30,
                secret: new Secret({ size: 20 }),
            });
            const token = await createChallenge(
                transaction,
                this.accounts.configuration.encryptionKey,
                principal.user.id,
                principal.session.id,
                "totp-enrollment",
                { label, secret: totp.secret.base32 }
            );
            return { token, secret: totp.secret.base32, uri: totp.toString() };
        });
    }

    async confirmTotp(principal: Principal, token: string, code: string) {
        await rateLimit(
            this.accounts.database,
            `proof:${principal.user.id}`,
            10,
            300_000
        );
        return this.accounts.protectedAction(principal, async (transaction) => {
            await this.ensureRoom(transaction, principal.user.id);
            const challenge = await takeChallenge(
                transaction,
                this.accounts.configuration.encryptionKey,
                token,
                "totp-enrollment",
                principal.user.id,
                principal.session.id
            );
            const data = v.parse(
                v.object({ label: v.string(), secret: v.string() }),
                challenge.data
            );
            const totp = new TOTP({ secret: data.secret });
            const delta = totp.validate({ token: code, window: 1 });
            if (delta === null) invalidProof();
            const enabled = await this.accounts.hasMfa(principal.user.id, transaction);
            const id = crypto.randomUUID();
            await transaction.insert(factors).values({
                id,
                userId: principal.user.id,
                kind: "totp",
                label: data.label,
                encryptedData: encryptValue(
                    this.accounts.configuration.encryptionKey,
                    `factor:${id}`,
                    { secret: data.secret }
                ),
                counter: Math.floor(Date.now() / 30_000) + delta,
                createdAt: new Date(),
                lastUsedAt: new Date(),
            });
            await audit(transaction, principal.user.id, "totp_enrolled");
            return this.finishEnrollment(transaction, principal, enabled);
        });
    }

    async beginWebAuthn(principal: Principal, origin: string) {
        return this.accounts.protectedAction(principal, async (transaction) => {
            await this.ensureRoom(transaction, principal.user.id);
            const inventory = await transaction
                .select({ id: factors.credentialId })
                .from(factors)
                .where(eq(factors.userId, principal.user.id));
            const options = await generateRegistrationOptions({
                rpName: "Homelab",
                rpID: this.accounts.configuration.rpId,
                userName: principal.user.username,
                userID: new TextEncoder().encode(principal.user.id),
                attestationType: "none",
                authenticatorSelection: {
                    residentKey: "preferred",
                    userVerification: "required",
                },
                excludeCredentials: inventory.flatMap((factor) =>
                    factor.id ? [{ id: factor.id }] : []
                ),
            });
            const token = await createChallenge(
                transaction,
                this.accounts.configuration.encryptionKey,
                principal.user.id,
                principal.session.id,
                "webauthn-enrollment",
                { challenge: options.challenge, origin }
            );
            return { token, options };
        });
    }

    async confirmWebAuthn(
        principal: Principal,
        token: string,
        label: string,
        response: RegistrationResponseJSON
    ) {
        await rateLimit(
            this.accounts.database,
            `proof:${principal.user.id}`,
            10,
            300_000
        );
        return this.accounts.protectedAction(principal, async (transaction) => {
            await this.ensureRoom(transaction, principal.user.id);
            const challenge = await takeChallenge(
                transaction,
                this.accounts.configuration.encryptionKey,
                token,
                "webauthn-enrollment",
                principal.user.id,
                principal.session.id
            );
            const data = v.parse(originChallengeSchema, challenge.data);
            const result = await verifyRegistrationResponse({
                response,
                expectedChallenge: data.challenge,
                expectedOrigin: data.origin,
                expectedRPID: this.accounts.configuration.rpId,
                requireUserVerification: true,
            }).catch(() => invalidProof());
            if (!result.verified || !result.registrationInfo) invalidProof();
            const enabled = await this.accounts.hasMfa(principal.user.id, transaction);
            const id = crypto.randomUUID();
            const credential = result.registrationInfo.credential;
            await transaction.insert(factors).values({
                id,
                userId: principal.user.id,
                kind: "webauthn",
                label,
                credentialId: credential.id,
                encryptedData: encryptValue(
                    this.accounts.configuration.encryptionKey,
                    `factor:${id}`,
                    {
                        publicKey: Buffer.from(credential.publicKey).toString(
                            "base64url"
                        ),
                        transports: credential.transports ?? [],
                    }
                ),
                counter: credential.counter,
                createdAt: new Date(),
            });
            await audit(transaction, principal.user.id, "webauthn_enrolled");
            return this.finishEnrollment(transaction, principal, enabled);
        });
    }

    async beginWebAuthnProof(principal: Principal, origin: string) {
        const inventory = await this.accounts.database
            .select()
            .from(factors)
            .where(
                and(eq(factors.userId, principal.user.id), eq(factors.kind, "webauthn"))
            );
        if (inventory.length === 0) invalidProof();
        const options = await generateAuthenticationOptions({
            rpID: this.accounts.configuration.rpId,
            userVerification: "required",
            allowCredentials: inventory.flatMap((factor) => {
                if (!factor.credentialId) return [];
                const data = v.parse(
                    webauthnDataSchema,
                    decryptValue(
                        this.accounts.configuration.encryptionKey,
                        `factor:${factor.id}`,
                        factor.encryptedData
                    )
                );
                return [
                    {
                        id: factor.credentialId,
                        transports: data.transports as AuthenticatorTransport[],
                    },
                ];
            }),
        });
        const token = await createChallenge(
            this.accounts.database,
            this.accounts.configuration.encryptionKey,
            principal.user.id,
            principal.session.id,
            "webauthn-proof",
            { challenge: options.challenge, origin }
        );
        return { token, options };
    }

    async webauthnProof(
        principal: Principal,
        token: string,
        response: AuthenticationResponseJSON
    ): Promise<void> {
        await rateLimit(
            this.accounts.database,
            `proof:${principal.user.id}`,
            10,
            300_000
        );
        await this.accounts.database.transaction(async (transaction) => {
            await transaction
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, principal.user.id))
                .for("update");
            await this.accounts.principalById(principal.session.id, transaction);
            const challenge = await takeChallenge(
                transaction,
                this.accounts.configuration.encryptionKey,
                token,
                "webauthn-proof",
                principal.user.id,
                principal.session.id
            );
            const expected = v.parse(originChallengeSchema, challenge.data);
            const [factor] = await transaction
                .select()
                .from(factors)
                .where(
                    and(
                        eq(factors.userId, principal.user.id),
                        eq(factors.credentialId, response.id)
                    )
                );
            if (!factor || factor.kind !== "webauthn") invalidProof();
            const data = v.parse(
                webauthnDataSchema,
                decryptValue(
                    this.accounts.configuration.encryptionKey,
                    `factor:${factor.id}`,
                    factor.encryptedData
                )
            );
            const result = await verifyAuthenticationResponse({
                response,
                expectedChallenge: expected.challenge,
                expectedOrigin: expected.origin,
                expectedRPID: this.accounts.configuration.rpId,
                requireUserVerification: true,
                credential: {
                    id: response.id,
                    publicKey: new Uint8Array(Buffer.from(data.publicKey, "base64url")),
                    counter: factor.counter,
                    transports: data.transports,
                },
            }).catch(() => invalidProof());
            if (!result.verified) invalidProof();
            await transaction
                .update(factors)
                .set({
                    counter: result.authenticationInfo.newCounter,
                    lastUsedAt: new Date(),
                })
                .where(eq(factors.id, factor.id));
            await this.accounts.completeMfa(transaction, principal);
            await audit(transaction, principal.user.id, "webauthn_verified");
        });
    }

    async codeProof(
        principal: Principal,
        code: string,
        recovery: boolean
    ): Promise<void> {
        await rateLimit(
            this.accounts.database,
            `proof:${principal.user.id}`,
            10,
            300_000
        );
        await this.accounts.database.transaction(async (transaction) => {
            await transaction
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, principal.user.id))
                .for("update");
            await this.accounts.principalById(principal.session.id, transaction);
            if (recovery) {
                const [consumed] = await transaction
                    .delete(recoveryCodes)
                    .where(
                        and(
                            eq(recoveryCodes.userId, principal.user.id),
                            eq(recoveryCodes.digest, tokenDigest(code))
                        )
                    )
                    .returning();
                if (!consumed) invalidProof();
            } else {
                const inventory = await transaction
                    .select()
                    .from(factors)
                    .where(
                        and(
                            eq(factors.userId, principal.user.id),
                            eq(factors.kind, "totp")
                        )
                    );
                let accepted = false;
                for (const factor of inventory) {
                    const data = v.parse(
                        totpDataSchema,
                        decryptValue(
                            this.accounts.configuration.encryptionKey,
                            `factor:${factor.id}`,
                            factor.encryptedData
                        )
                    );
                    const delta = new TOTP({ secret: data.secret }).validate({
                        token: code,
                        window: 1,
                    });
                    const step = Math.floor(Date.now() / 30_000) + (delta ?? 0);
                    if (delta !== null && step > factor.counter) {
                        await transaction
                            .update(factors)
                            .set({ counter: step, lastUsedAt: new Date() })
                            .where(eq(factors.id, factor.id));
                        accepted = true;
                        break;
                    }
                }
                if (!accepted) invalidProof();
            }
            await this.accounts.completeMfa(transaction, principal);
            await audit(
                transaction,
                principal.user.id,
                recovery ? "recovery_code_used" : "totp_verified"
            );
        });
    }

    async remove(principal: Principal, factorId: string): Promise<void> {
        await this.accounts.protectedAction(principal, async (transaction) => {
            const removed = await transaction
                .delete(factors)
                .where(
                    and(eq(factors.id, factorId), eq(factors.userId, principal.user.id))
                )
                .returning();
            if (removed.length === 0)
                throw new AuthFailure("NOT_FOUND", 404, "Security method not found.");
            if (!(await this.accounts.hasMfa(principal.user.id, transaction))) {
                await transaction
                    .delete(recoveryCodes)
                    .where(eq(recoveryCodes.userId, principal.user.id));
                await this.accounts.revokeOthers(transaction, principal);
                // Drop every grant issued with the old assurance level, including dashboard grants.
                await this.accounts.revokeGrants(transaction, principal.session.id);
                await transaction
                    .update(sessions)
                    .set({ mfaAt: null })
                    .where(eq(sessions.id, principal.session.id));
            }
            await audit(transaction, principal.user.id, "factor_removed");
        });
    }
}
