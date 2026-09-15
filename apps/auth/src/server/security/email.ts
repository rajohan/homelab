import { and, eq, gt, isNull, lte } from "drizzle-orm";
import * as v from "valibot";

import type { AuthStore } from "../database/connection";
import { challenges, mailOutbox, sessions, users } from "../database/schema";
import { type Accounts, type Principal } from "./accounts";
import { decryptValue, encryptValue, hashPassword, tokenDigest } from "./crypto";
import { AuthFailure, invalidProof } from "./errors";
import { audit, createChallenge, rateLimit, takeChallenge } from "./store";

const messageSchema = v.strictObject({
    to: v.string(),
    subject: v.string(),
    text: v.string(),
});
const queuedMessageSchema = v.union([
    messageSchema,
    v.strictObject({ resetUsername: v.string() }),
]);
export type AuthEmail = v.InferOutput<typeof messageSchema>;
export type EmailDelivery = (id: string, message: AuthEmail) => Promise<void>;

export class AccountEmail {
    readonly accounts: Accounts;
    readonly deliver: EmailDelivery;
    constructor(accounts: Accounts, delivery?: EmailDelivery) {
        this.accounts = accounts;
        this.deliver =
            delivery ??
            (async (id, message) => {
                const configuration = accounts.configuration;
                if (!configuration.resendKey)
                    throw new Error("Email delivery is not configured");
                const response = await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${configuration.resendKey}`,
                        "Content-Type": "application/json",
                        "Idempotency-Key": id,
                    },
                    body: JSON.stringify({
                        from: configuration.emailFrom,
                        to: [message.to],
                        subject: message.subject,
                        text: message.text,
                    }),
                    signal: AbortSignal.timeout(10_000),
                    redirect: "error",
                });
                if (!response.ok) throw new Error("Email delivery was not accepted");
            });
    }

    async enqueue(
        store: AuthStore,
        message: v.InferOutput<typeof queuedMessageSchema>,
        proofToken?: string
    ): Promise<void> {
        const now = new Date();
        const id = crypto.randomUUID();
        await store.insert(mailOutbox).values({
            id,
            proofDigest: proofToken ? tokenDigest(proofToken) : null,
            encryptedData: encryptValue(
                this.accounts.configuration.encryptionKey,
                `mail:${id}`,
                message
            ),
            createdAt: now,
            nextAttemptAt: now,
            expiresAt: new Date(now.getTime() + 30 * 60_000),
        });
    }

    async requestEmail(principal: Principal, email: string): Promise<void> {
        await this.accounts.requireFresh(principal);
        await rateLimit(
            this.accounts.database,
            `email:${principal.user.id}`,
            3,
            3_600_000
        );
        await this.accounts.protectedAction(principal, async (transaction) => {
            await transaction
                .delete(challenges)
                .where(
                    and(
                        eq(challenges.userId, principal.user.id),
                        eq(challenges.purpose, "email")
                    )
                );
            const token = await createChallenge(
                transaction,
                this.accounts.configuration.encryptionKey,
                principal.user.id,
                principal.session.id,
                "email",
                { email },
                30 * 60_000
            );
            await this.enqueue(
                transaction,
                {
                    to: email,
                    subject: "Verify your Homelab email",
                    text: `Confirm your email within 30 minutes: ${this.accounts.configuration.issuer}/verify-email#token=${token}\nIf you did not request this change, ignore this message.`,
                },
                token
            );
            await audit(transaction, principal.user.id, "email_verification_requested");
        });
    }

    async verifyEmail(token: string): Promise<void> {
        await this.accounts.database.transaction(async (transaction) => {
            const { user, challenge } = await this.takeAccountProof(
                transaction,
                token,
                "email"
            );
            if (!challenge.sessionId) invalidProof();
            await this.accounts.principalById(challenge.sessionId, transaction);
            const { email } = v.parse(
                v.object({ email: v.pipe(v.string(), v.email()) }),
                challenge.data
            );
            const [occupied] = await transaction
                .select({ id: users.id })
                .from(users)
                .where(eq(users.email, email));
            if (occupied && occupied.id !== user.id)
                throw new AuthFailure(
                    "EMAIL_UNAVAILABLE",
                    409,
                    "This email address cannot be used."
                );
            await transaction
                .update(users)
                .set({ email, emailVerified: true })
                .where(eq(users.id, user.id));
            // Recovery links sent to the previous mailbox must lose authority atomically.
            if (user.email !== email)
                await transaction
                    .delete(challenges)
                    .where(
                        and(
                            eq(challenges.userId, user.id),
                            eq(challenges.purpose, "password-reset")
                        )
                    );
            if (user.emailVerified && user.email !== email)
                await this.enqueue(transaction, {
                    to: user.email,
                    subject: "Your Homelab email changed",
                    text: "Your account email was changed. If this was not you, contact your homelab administrator using a trusted recovery channel.",
                });
            await audit(transaction, user.id, "email_verified");
        });
    }

    async requestReset(username: string, remote: string): Promise<void> {
        // Four reset jobs/minute leaves capacity for verified-user mail in the
        // shared five-jobs-per-cycle worker, even with distributed unknown names.
        await rateLimit(this.accounts.database, "reset-global", 4, 60_000);
        await rateLimit(this.accounts.database, `reset-ip:${remote}`, 10, 3_600_000);
        await rateLimit(
            this.accounts.database,
            `reset-user:${username.toLowerCase()}`,
            3,
            3_600_000
        );
        // The public response never looks up an account. Identical encrypted queue
        // work is performed for known, unknown and unverified usernames.
        await this.enqueue(this.accounts.database, {
            resetUsername: username.toLowerCase(),
        });
    }

    private async prepareReset(transaction: AuthStore, username: string): Promise<void> {
        const [user] = await transaction
            .select()
            .from(users)
            .where(eq(users.username, username))
            .for("update");
        if (!user?.emailVerified) return;
        // Cascading proof ownership cancels superseded or invalidated queued mail.
        await transaction
            .delete(challenges)
            .where(
                and(
                    eq(challenges.userId, user.id),
                    eq(challenges.purpose, "password-reset")
                )
            );
        const token = await createChallenge(
            transaction,
            this.accounts.configuration.encryptionKey,
            user.id,
            null,
            "password-reset",
            {},
            30 * 60_000
        );
        await this.enqueue(
            transaction,
            {
                to: user.email,
                subject: "Reset your Homelab password",
                text: `Reset your password within 30 minutes: ${this.accounts.configuration.issuer}/reset-password#token=${token}\nYour existing two-factor methods remain required. If you did not request this, ignore this message.`,
            },
            token
        );
        await audit(transaction, user.id, "password_reset_requested");
    }

    async resetPassword(token: string, password: string): Promise<void> {
        const [pending] = await this.accounts.database
            .select({ digest: challenges.digest })
            .from(challenges)
            .where(
                and(
                    eq(challenges.digest, tokenDigest(token)),
                    eq(challenges.purpose, "password-reset"),
                    gt(challenges.expiresAt, new Date())
                )
            )
            .limit(1);
        if (!pending) invalidProof();
        const passwordHash = await hashPassword(password);
        await this.accounts.database.transaction(async (transaction) => {
            const { challenge } = await this.takeAccountProof(
                transaction,
                token,
                "password-reset"
            );
            await transaction
                .update(users)
                .set({ passwordHash })
                .where(eq(users.id, challenge.userId));
            const active = await transaction
                .select({ id: sessions.id })
                .from(sessions)
                .where(eq(sessions.userId, challenge.userId));
            for (const session of active)
                await this.accounts.revoke(transaction, session.id);
            await transaction
                .delete(challenges)
                .where(eq(challenges.userId, challenge.userId));
            await audit(transaction, challenge.userId, "password_reset_completed");
        });
    }

    private async takeAccountProof(
        store: AuthStore,
        token: string,
        purpose: "email" | "password-reset"
    ) {
        const [pending] = await store
            .select({ userId: challenges.userId })
            .from(challenges)
            .where(
                and(
                    eq(challenges.digest, tokenDigest(token)),
                    eq(challenges.purpose, purpose),
                    gt(challenges.expiresAt, new Date())
                )
            )
            .limit(1);
        if (!pending) invalidProof();
        // Use the same lock order as session revocation and other account mutations.
        // A proof invalidated while waiting must be rechecked after acquiring the lock.
        const [user] = await store
            .select()
            .from(users)
            .where(eq(users.id, pending.userId))
            .for("update");
        if (!user) invalidProof();
        const challenge = await takeChallenge(
            store,
            this.accounts.configuration.encryptionKey,
            token,
            purpose,
            user.id
        );
        return { user, challenge };
    }

    async deliverPending(): Promise<number> {
        let delivered = 0;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const handled = await this.accounts.database.transaction(
                async (transaction) => {
                    const now = new Date();
                    const [message] = await transaction
                        .select()
                        .from(mailOutbox)
                        .where(
                            and(
                                isNull(mailOutbox.sentAt),
                                lte(mailOutbox.nextAttemptAt, now),
                                gt(mailOutbox.expiresAt, now)
                            )
                        )
                        .orderBy(mailOutbox.createdAt)
                        .limit(1)
                        .for("update", { skipLocked: true });
                    if (!message) return false;
                    try {
                        const payload = v.parse(
                            queuedMessageSchema,
                            decryptValue(
                                this.accounts.configuration.encryptionKey,
                                `mail:${message.id}`,
                                message.encryptedData
                            )
                        );
                        if ("resetUsername" in payload) {
                            await this.prepareReset(transaction, payload.resetUsername);
                            await transaction
                                .delete(mailOutbox)
                                .where(eq(mailOutbox.id, message.id));
                            return true;
                        }
                        await this.deliver(message.id, payload);
                        await transaction
                            .update(mailOutbox)
                            .set({
                                sentAt: new Date(),
                                encryptedData: "",
                                attempts: message.attempts + 1,
                            })
                            .where(eq(mailOutbox.id, message.id));
                        delivered += 1;
                    } catch {
                        await transaction
                            .update(mailOutbox)
                            .set({
                                attempts: message.attempts + 1,
                                nextAttemptAt: new Date(
                                    Date.now() +
                                        Math.min(300_000, 15_000 * 2 ** message.attempts)
                                ),
                            })
                            .where(eq(mailOutbox.id, message.id));
                        process.stderr.write(
                            JSON.stringify({
                                service: "auth",
                                event: "email_delivery_failed",
                            }) + "\n"
                        );
                    }
                    return true;
                }
            );
            if (!handled) break;
        }
        return delivered;
    }
}
