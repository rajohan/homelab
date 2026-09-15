import { and, desc, eq, gt, isNull, isNotNull, lte, ne, or } from "drizzle-orm";

import type { AuthConfiguration } from "../config/configuration";
import type { AuthDatabase, AuthStore, AuthTransaction } from "../database/connection";
import {
    challenges,
    factors,
    grantSessions,
    recoveryCodes,
    sessions,
    users,
} from "../database/schema";
import { revokeBoundGrants } from "../oidc/logout";
import { hashPassword, randomToken, tokenDigest, verifyPassword } from "./crypto";
import { AuthFailure, denied, invalidProof, requireRecent } from "./errors";
import { audit, rateLimit } from "./store";

export interface Principal {
    readonly user: typeof users.$inferSelect;
    readonly session: typeof sessions.$inferSelect;
}

const sessionLifetime = 12 * 60 * 60_000;
const idleLifetime = 60 * 60_000;

export class Accounts {
    readonly database: AuthDatabase;
    readonly configuration: AuthConfiguration;
    readonly dummyHash: Promise<string>;

    /**
     * Bind account operations to the database and validated identity settings.
     * @param database - The auth database.
     * @param configuration - The current deployment policy and keys.
     */
    constructor(database: AuthDatabase, configuration: AuthConfiguration) {
        this.database = database;
        this.configuration = configuration;
        this.dummyHash = hashPassword(randomToken());
    }

    /**
     * Verify a password using the bounded password hashing service.
     * @param password - The candidate password.
     * @param hash - The stored Argon2 password hash.
     * @returns Whether the password matches.
     */
    async checkPassword(password: string, hash: string): Promise<boolean> {
        return verifyPassword(password, hash);
    }

    /**
     * Resolve a live, non-idle session and its account without renewing activity.
     * @param id - The nonsecret session record identifier.
     * @param store - The database or caller-owned transaction.
     * @returns The active session and account principal.
     */
    async principalById(
        id: string,
        store: AuthStore = this.database
    ): Promise<Principal> {
        const now = new Date();
        const [principal] = await store
            .select({ session: sessions, user: users })
            .from(sessions)
            .innerJoin(users, eq(users.id, sessions.userId))
            .where(
                and(
                    eq(sessions.id, id),
                    gt(sessions.expiresAt, now),
                    gt(sessions.lastSeenAt, new Date(now.getTime() - idleLifetime))
                )
            )
            .limit(1);
        if (!principal) denied();
        return principal;
    }

    /**
     * Resolve an opaque session token through its stored digest.
     * @param token - The presented session token.
     * @returns The live session/account principal.
     */
    async principalByToken(token: string): Promise<Principal> {
        const [session] = await this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.tokenHash, tokenDigest(token)))
            .limit(1);
        if (!session) denied();
        return this.principalById(session.id);
    }

    /**
     * Check whether the account has any enrolled second factor.
     * @param userId - The account identifier.
     * @param store - The database or caller-owned transaction.
     * @returns Whether at least one factor is enrolled.
     */
    async hasMfa(userId: string, store: AuthStore = this.database): Promise<boolean> {
        const found = await store
            .select({ id: factors.id })
            .from(factors)
            .where(eq(factors.userId, userId))
            .limit(1);
        return found.length > 0;
    }

    /**
     * Require completion of MFA when the account has enrolled factors.
     * @param principal - The current account/session principal.
     * @param store - The database or caller-owned transaction.
     * @returns Completion when the session meets the account's authentication requirements.
     */
    async requireAuthenticated(
        principal: Principal,
        store: AuthStore = this.database
    ): Promise<void> {
        if ((await this.hasMfa(principal.user.id, store)) && !principal.session.mfaAt) {
            throw new AuthFailure(
                "MFA_REQUIRED",
                403,
                "Complete two-factor authentication."
            );
        }
    }

    /**
     * Require authenticated and recent password or second-factor proof.
     * @param principal - The current account/session principal.
     * @param store - The database or caller-owned transaction.
     * @returns Completion when a protected account action may proceed.
     */
    async requireFresh(
        principal: Principal,
        store: AuthStore = this.database
    ): Promise<void> {
        await this.requireAuthenticated(principal, store);
        requireRecent(
            (await this.hasMfa(principal.user.id, store))
                ? principal.session.mfaAt
                : principal.session.passwordAt,
            new Date()
        );
    }

    /**
     * Serialize an account mutation, recheck fresh identity and renew activity only on success.
     * @param principal - The initiating account/session principal.
     * @param action - The mutation run inside the locked account transaction.
     * @returns The mutation result after the transaction commits.
     */
    async protectedAction<T>(
        principal: Principal,
        action: (transaction: AuthTransaction, current: Principal) => Promise<T>
    ): Promise<T> {
        return this.database.transaction(async (transaction) => {
            // Serialize account mutations so concurrent enrollments/removals cannot defeat limits.
            await transaction
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, principal.user.id))
                .for("update");
            const current = await this.principalById(principal.session.id, transaction);
            await this.requireFresh(current, transaction);
            const result = await action(transaction, current);
            await transaction
                .update(sessions)
                .set({ lastSeenAt: new Date() })
                .where(eq(sessions.id, current.session.id));
            return result;
        });
    }

    /**
     * Check rate-limited credentials and create a session pending MFA when required.
     * @param username - The submitted account name.
     * @param password - The submitted password.
     * @param remote - The trusted peer identifier for admission limits.
     * @param userAgent - The client description stored with the new session.
     * @returns The opaque session token and whether a second factor is required.
     */
    async login(
        username: string,
        password: string,
        remote: string,
        userAgent: string
    ): Promise<{ token: string; mfaRequired: boolean }> {
        await rateLimit(this.database, `login-ip:${remote}`, 20, 60_000);
        await rateLimit(
            this.database,
            `login-user:${username.toLowerCase()}`,
            10,
            300_000
        );
        const [user] = await this.database
            .select()
            .from(users)
            .where(eq(users.username, username.toLowerCase()))
            .limit(1);
        const valid = await this.checkPassword(
            password,
            user?.passwordHash ?? (await this.dummyHash)
        );
        if (!user || !valid)
            throw new AuthFailure(
                "INVALID_LOGIN",
                401,
                "The username or password is incorrect."
            );
        const token = randomToken();
        const now = new Date();
        await this.database.transaction(async (transaction) => {
            const [locked] = await transaction
                .select({ passwordHash: users.passwordHash })
                .from(users)
                .where(eq(users.id, user.id))
                .for("update");
            if (locked?.passwordHash !== user.passwordHash) invalidProof();
            const existing = await transaction
                .select({ id: sessions.id })
                .from(sessions)
                .where(and(eq(sessions.userId, user.id), isNull(sessions.mfaAt)))
                .orderBy(desc(sessions.createdAt));
            for (const session of existing.slice(15))
                await this.revoke(transaction, session.id);
            await transaction.insert(sessions).values({
                id: crypto.randomUUID(),
                userId: user.id,
                tokenHash: tokenDigest(token),
                createdAt: now,
                lastSeenAt: now,
                expiresAt: new Date(now.getTime() + sessionLifetime),
                passwordAt: now,
                mfaAt: null,
                userAgent: userAgent.slice(0, 256),
            });
            await audit(transaction, user.id, "password_login");
        });
        return { token, mfaRequired: await this.hasMfa(user.id) };
    }

    /**
     * Mark second-factor completion and enforce the verified-session limit.
     * @param store - The caller-owned transaction.
     * @param principal - The session whose second factor was verified.
     * @returns Completion after verification state and session limits are updated.
     */
    async completeMfa(store: AuthStore, principal: Principal): Promise<void> {
        await store
            .update(sessions)
            .set({ mfaAt: new Date(), lastSeenAt: new Date() })
            .where(eq(sessions.id, principal.session.id));
        // Only a completed second factor may displace another verified session.
        const others = await store
            .select({ id: sessions.id })
            .from(sessions)
            .where(
                and(
                    eq(sessions.userId, principal.user.id),
                    isNotNull(sessions.mfaAt),
                    ne(sessions.id, principal.session.id)
                )
            )
            .orderBy(desc(sessions.lastSeenAt));
        for (const session of others.slice(15)) await this.revoke(store, session.id);
    }

    /**
     * Renew genuine session activity at most once per minute.
     * @param principal - The authenticated session handling accepted user activity.
     * @returns Completion after any required timestamp update.
     */
    async touch(principal: Principal): Promise<void> {
        if (Date.now() - principal.session.lastSeenAt.getTime() >= 60_000) {
            await this.database
                .update(sessions)
                .set({ lastSeenAt: new Date() })
                .where(eq(sessions.id, principal.session.id));
        }
    }

    /**
     * Recheck an expiry candidate under the same account lock used by protected mutations.
     * @param sessionId - A session selected by the maintenance batch; it may have become active.
     * @param now - The maintenance batch's expiry cutoff.
     * @returns Completion after revoking a still-expired session, or retaining a refreshed one.
     */
    async revokeExpired(sessionId: string, now: Date): Promise<void> {
        await this.database.transaction(async (transaction) => {
            const [candidate] = await transaction
                .select({ userId: sessions.userId })
                .from(sessions)
                .where(eq(sessions.id, sessionId));
            if (!candidate) return;
            // Match protectedAction's account-first lock order before inspecting the session.
            await transaction
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, candidate.userId))
                .for("update");
            const [expired] = await transaction
                .select({ id: sessions.id })
                .from(sessions)
                .where(
                    and(
                        eq(sessions.id, sessionId),
                        or(
                            lte(sessions.expiresAt, now),
                            lte(
                                sessions.lastSeenAt,
                                new Date(now.getTime() - idleLifetime)
                            )
                        )
                    )
                )
                .for("update");
            // The session lock also serializes touch() and rechecks a concurrent timestamp update.
            if (expired) await this.revoke(transaction, expired.id);
        });
    }

    /**
     * Revoke a session's OIDC grants and preserve pending logout notifications.
     * @param store - The caller-owned transaction.
     * @param sessionId - The central session whose grants are revoked.
     * @returns Completion after grant invalidation and notification enqueue.
     */
    async revokeGrants(store: AuthStore, sessionId: string): Promise<void> {
        await revokeBoundGrants(store, eq(grantSessions.sessionId, sessionId));
    }

    /**
     * Revoke a session and its grants within the caller's transaction.
     * @param store - The caller-owned transaction.
     * @param sessionId - The session to remove.
     * @returns Completion after the session and dependent grants are invalidated.
     */
    async revoke(store: AuthStore, sessionId: string): Promise<void> {
        await this.revokeGrants(store, sessionId);
        await store.delete(sessions).where(eq(sessions.id, sessionId));
    }

    /**
     * Revoke every other session belonging to the same account.
     * @param store - The caller-owned transaction.
     * @param principal - The account and session to retain.
     * @returns The number of other sessions revoked.
     */
    async revokeOthers(store: AuthStore, principal: Principal): Promise<number> {
        const others = await store
            .select({ id: sessions.id })
            .from(sessions)
            .where(
                and(
                    eq(sessions.userId, principal.user.id),
                    ne(sessions.id, principal.session.id)
                )
            );
        for (const session of others) await this.revoke(store, session.id);
        return others.length;
    }

    /**
     * Revoke the current authenticated session without step-up; require fresh proof for others.
     * @param principal - The session requesting the protected action.
     * @param sessionId - The owned session to revoke.
     * @returns Completion after the revocation commits.
     */
    async revokeSession(principal: Principal, sessionId: string): Promise<void> {
        if (sessionId === principal.session.id) {
            await this.database.transaction(async (transaction) => {
                const current = await this.principalById(
                    principal.session.id,
                    transaction
                );
                await this.requireAuthenticated(current, transaction);
                await this.revoke(transaction, current.session.id);
                await audit(transaction, current.user.id, "session_revoked");
            });
            return;
        }
        await this.protectedAction(principal, async (transaction) => {
            const [session] = await transaction
                .select()
                .from(sessions)
                .where(
                    and(
                        eq(sessions.id, sessionId),
                        eq(sessions.userId, principal.user.id)
                    )
                );
            if (!session) throw new AuthFailure("NOT_FOUND", 404, "Session not found.");
            await this.revoke(transaction, session.id);
            await audit(transaction, principal.user.id, "session_revoked");
        });
    }

    /**
     * Replace the verified password and revoke other sessions with concurrency checks.
     * @param principal - The initiating account/session principal.
     * @param currentPassword - The existing password to verify.
     * @param newPassword - The replacement password.
     * @returns Completion after the credential change commits.
     */
    async changePassword(
        principal: Principal,
        currentPassword: string,
        newPassword: string
    ): Promise<void> {
        await this.requireFresh(principal);
        if (!(await this.checkPassword(currentPassword, principal.user.passwordHash)))
            invalidProof();
        const passwordHash = await hashPassword(newPassword);
        await this.protectedAction(principal, async (transaction, current) => {
            if (current.user.passwordHash !== principal.user.passwordHash) invalidProof();
            await transaction
                .update(users)
                .set({ passwordHash })
                .where(eq(users.id, current.user.id));
            await this.revokeOthers(transaction, current);
            await transaction
                .delete(challenges)
                .where(eq(challenges.userId, current.user.id));
            await transaction
                .update(sessions)
                .set({ passwordAt: new Date(), lastSeenAt: new Date() })
                .where(eq(sessions.id, current.session.id));
            await audit(transaction, current.user.id, "password_changed");
        });
    }

    /**
     * Verify a rate-limited password proof and update proof freshness and genuine activity.
     * @param principal - The session requesting step-up.
     * @param password - The password proof.
     * @returns Completion after current credentials are rechecked transactionally.
     */
    async reauthenticatePassword(principal: Principal, password: string): Promise<void> {
        await rateLimit(this.database, `proof:${principal.user.id}`, 10, 300_000);
        if (!(await this.checkPassword(password, principal.user.passwordHash)))
            invalidProof();
        await this.database.transaction(async (transaction) => {
            await transaction
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, principal.user.id))
                .for("update");
            const current = await this.principalById(principal.session.id, transaction);
            if (current.user.passwordHash !== principal.user.passwordHash) invalidProof();
            await transaction
                .update(sessions)
                .set({ passwordAt: new Date(), lastSeenAt: new Date() })
                .where(eq(sessions.id, principal.session.id));
            await audit(transaction, principal.user.id, "password_reauthenticated");
        });
    }

    /**
     * Read safe account, factor, session and audit metadata without renewing idle time.
     * @param principal - The authenticated account/session principal.
     * @returns The account settings snapshot without credential secrets.
     */
    async snapshot(principal: Principal) {
        // Account snapshots are passive reads, including credentialed cross-site GETs.
        await this.requireAuthenticated(principal);
        const inventory = await this.database
            .select({
                id: factors.id,
                kind: factors.kind,
                label: factors.label,
                createdAt: factors.createdAt,
                lastUsedAt: factors.lastUsedAt,
            })
            .from(factors)
            .where(eq(factors.userId, principal.user.id))
            .orderBy(factors.createdAt);
        const activeSessions = await this.database
            .select({
                id: sessions.id,
                userAgent: sessions.userAgent,
                createdAt: sessions.createdAt,
                lastSeenAt: sessions.lastSeenAt,
                expiresAt: sessions.expiresAt,
            })
            .from(sessions)
            .where(
                and(
                    eq(sessions.userId, principal.user.id),
                    gt(sessions.expiresAt, new Date()),
                    gt(sessions.lastSeenAt, new Date(Date.now() - idleLifetime))
                )
            )
            .orderBy(desc(sessions.lastSeenAt));
        const codes = await this.database
            .select({ digest: recoveryCodes.digest })
            .from(recoveryCodes)
            .where(eq(recoveryCodes.userId, principal.user.id));
        return {
            user: {
                id: principal.user.id,
                username: principal.user.username,
                email: principal.user.email,
                emailVerified: principal.user.emailVerified,
            },
            factors: inventory,
            recoveryCodesRemaining: codes.length,
            sessions: activeSessions.map((session) => ({
                ...session,
                current: session.id === principal.session.id,
            })),
        };
    }
}
