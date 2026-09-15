import { and, desc, eq, gt, isNull, isNotNull, ne } from "drizzle-orm";

import type { AuthConfiguration } from "../config/configuration";
import type { AuthDatabase, AuthStore, AuthTransaction } from "../database/connection";
import {
    auditEvents,
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

    constructor(database: AuthDatabase, configuration: AuthConfiguration) {
        this.database = database;
        this.configuration = configuration;
        this.dummyHash = hashPassword(randomToken());
    }

    async checkPassword(password: string, hash: string): Promise<boolean> {
        return verifyPassword(password, hash);
    }

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

    async principalByToken(token: string): Promise<Principal> {
        const [session] = await this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.tokenHash, tokenDigest(token)))
            .limit(1);
        if (!session) denied();
        return this.principalById(session.id);
    }

    async hasMfa(userId: string, store: AuthStore = this.database): Promise<boolean> {
        const found = await store
            .select({ id: factors.id })
            .from(factors)
            .where(eq(factors.userId, userId))
            .limit(1);
        return found.length > 0;
    }

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

    async touch(principal: Principal): Promise<void> {
        if (Date.now() - principal.session.lastSeenAt.getTime() >= 60_000) {
            await this.database
                .update(sessions)
                .set({ lastSeenAt: new Date() })
                .where(eq(sessions.id, principal.session.id));
        }
    }

    async revokeGrants(store: AuthStore, sessionId: string): Promise<void> {
        await revokeBoundGrants(store, eq(grantSessions.sessionId, sessionId));
    }

    async revoke(store: AuthStore, sessionId: string): Promise<void> {
        await this.revokeGrants(store, sessionId);
        await store.delete(sessions).where(eq(sessions.id, sessionId));
    }

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

    async revokeSession(principal: Principal, sessionId: string): Promise<void> {
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
        const events = await this.database
            .select({
                id: auditEvents.id,
                event: auditEvents.event,
                createdAt: auditEvents.createdAt,
            })
            .from(auditEvents)
            .where(eq(auditEvents.userId, principal.user.id))
            .orderBy(desc(auditEvents.createdAt))
            .limit(50);
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
            events,
        };
    }
}
