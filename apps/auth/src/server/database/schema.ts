import {
    bigint,
    boolean,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("auth_users", {
    id: uuid("id").primaryKey(),
    username: text("username").notNull().unique(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    passwordHash: text("password_hash").notNull(),
    groups: jsonb("groups").$type<string[]>().notNull(),
    createdAt: time("created_at").notNull(),
});

export const sessions = pgTable(
    "auth_sessions",
    {
        id: uuid("id").primaryKey(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        tokenHash: text("token_hash").notNull().unique(),
        createdAt: time("created_at").notNull(),
        lastSeenAt: time("last_seen_at").notNull(),
        expiresAt: time("expires_at").notNull(),
        passwordAt: time("password_at").notNull(),
        mfaAt: time("mfa_at"),
        userAgent: text("user_agent").notNull(),
    },
    (table) => [index("auth_sessions_user_idx").on(table.userId)]
);

export const factors = pgTable(
    "auth_factors",
    {
        id: uuid("id").primaryKey(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: text("kind", { enum: ["totp", "webauthn"] }).notNull(),
        label: text("label").notNull(),
        credentialId: text("credential_id").unique(),
        encryptedData: text("encrypted_data").notNull(),
        counter: bigint("counter", { mode: "number" }).notNull().default(0),
        createdAt: time("created_at").notNull(),
        lastUsedAt: time("last_used_at"),
    },
    (table) => [index("auth_factors_user_idx").on(table.userId)]
);

export const recoveryCodes = pgTable(
    "auth_recovery_codes",
    {
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        digest: text("digest").notNull(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.digest] })]
);

export const challenges = pgTable(
    "auth_challenges",
    {
        digest: text("digest").primaryKey(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        sessionId: uuid("session_id").references(() => sessions.id, {
            onDelete: "cascade",
        }),
        purpose: text("purpose").notNull(),
        encryptedData: text("encrypted_data").notNull(),
        expiresAt: time("expires_at").notNull(),
    },
    (table) => [index("auth_challenges_expiry_idx").on(table.expiresAt)]
);

export const oidcRecords = pgTable(
    "auth_oidc_records",
    {
        digest: text("digest").primaryKey(),
        model: text("model").notNull(),
        encryptedData: text("encrypted_data").notNull(),
        grantId: text("grant_id"),
        uid: text("uid"),
        userCode: text("user_code"),
        consumedAt: integer("consumed_at"),
        expiresAt: time("expires_at").notNull(),
    },
    (table) => [
        index("auth_oidc_grant_idx").on(table.grantId),
        index("auth_oidc_uid_idx").on(table.uid),
        index("auth_oidc_expiry_idx").on(table.expiresAt),
    ]
);

export const grantSessions = pgTable("auth_grant_sessions", {
    grantId: text("grant_id").primaryKey(),
    encryptedLogout: text("encrypted_logout"),
    sessionId: uuid("session_id")
        .notNull()
        .references(() => sessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
});

export const auditEvents = pgTable(
    "auth_audit_events",
    {
        id: uuid("id").primaryKey(),
        userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
        event: text("event").notNull(),
        createdAt: time("created_at").notNull(),
    },
    (table) => [index("auth_audit_user_time_idx").on(table.userId, table.createdAt)]
);

export const rateBuckets = pgTable("auth_rate_buckets", {
    digest: text("digest").primaryKey(),
    attempts: integer("attempts").notNull(),
    expiresAt: time("expires_at").notNull(),
});

export const mailOutbox = pgTable("auth_mail_outbox", {
    id: uuid("id").primaryKey(),
    proofDigest: text("proof_digest").references(() => challenges.digest, {
        onDelete: "cascade",
    }),
    encryptedData: text("encrypted_data").notNull(),
    createdAt: time("created_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    nextAttemptAt: time("next_attempt_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    sentAt: time("sent_at"),
});

export const logoutOutbox = pgTable("auth_logout_outbox", {
    id: text("id").primaryKey(),
    encryptedData: text("encrypted_data").notNull(),
    createdAt: time("created_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    nextAttemptAt: time("next_attempt_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
});
