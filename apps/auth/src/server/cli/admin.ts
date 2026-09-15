import { generateKeyPairSync } from "node:crypto";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as v from "valibot";

import { authConfiguration } from "../config/environment";
import { connectAuthDatabase } from "../database/connection";
import { authMigrationsFolder } from "../database/migrations";
import { challenges, factors, recoveryCodes, sessions, users } from "../database/schema";
import { Accounts } from "../security/accounts";
import { hashPassword, randomToken } from "../security/crypto";
import { rotateDataKey } from "../security/keyRotation";
import { audit } from "../security/store";

const usernameSchema = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/));
const newUserSchema = v.strictObject({
    username: usernameSchema,
    email: v.pipe(v.string(), v.maxLength(254), v.email(), v.toLowerCase()),
    password: v.pipe(v.string(), v.minLength(12), v.maxLength(256)),
    groups: v.optional(v.array(v.pipe(v.string(), v.regex(/^[a-z0-9_-]{1,64}$/))), [
        "admins",
    ]),
    id: v.optional(v.pipe(v.string(), v.uuid())),
});
const recoverySchema = v.strictObject({
    username: usernameSchema,
    password: v.pipe(v.string(), v.minLength(12), v.maxLength(256)),
});

async function privateInput(): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of Bun.stdin.stream()) {
        length += chunk.byteLength;
        if (length > 16_384)
            throw new Error("Input exceeds the administrative request limit");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}
/**
 * Execute an explicit operator command without exposing persisted identity secrets.
 * @param command - The validated command name and arguments from the CLI.
 * @returns Completion after the requested command succeeds.
 */
export async function runAdmin(command: readonly string[]): Promise<void> {
    const [action, option] = command;
    if (action === "generate-keys" && command.length === 1) {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
        process.stdout.write(
            JSON.stringify({
                HOMELAB_AUTH_ENCRYPTION_KEY: Buffer.from(
                    crypto.getRandomValues(new Uint8Array(32))
                ).toString("base64"),
                HOMELAB_AUTH_COOKIE_KEY: randomToken(),
                HOMELAB_AUTH_PROXY_KEY: randomToken(),
                HOMELAB_AUTH_JWKS: JSON.stringify({
                    keys: [
                        {
                            ...privateKey.export({ format: "jwk" }),
                            kid: crypto.randomUUID(),
                            alg: "RS256",
                            use: "sig",
                        },
                    ],
                }),
                HOMELAB_DASHBOARD_SESSION_KEY: Buffer.from(
                    crypto.getRandomValues(new Uint8Array(32))
                ).toString("base64"),
            }) + "\n"
        );
        return;
    }
    if (
        !action ||
        !["migrate", "create-user", "recover-user", "rotate-data-key"].includes(action) ||
        (option !== undefined &&
            !(action === "recover-user" && option === "--reset-mfa") &&
            !(
                action === "rotate-data-key" &&
                ["--check", "--service-stopped"].includes(option)
            )) ||
        (action === "rotate-data-key" && !option) ||
        command.length > 2
    ) {
        throw new Error(
            "Use migrate, create-user, recover-user [--reset-mfa], rotate-data-key --check|--service-stopped, or generate-keys"
        );
    }
    const configuration = await authConfiguration();
    if (!configuration) throw new Error("Configure the isolated auth service first");
    const connection = connectAuthDatabase(configuration.databaseUrl);
    try {
        if (action === "rotate-data-key") {
            const input = v.parse(
                v.strictObject({
                    nextEncryptionKey: v.pipe(v.string(), v.base64(), v.length(44)),
                }),
                await privateInput()
            );
            const counts = await rotateDataKey(
                connection.database,
                configuration.encryptionKey,
                Buffer.from(input.nextEncryptionKey, "base64"),
                option === "--service-stopped"
            );
            process.stdout.write(
                JSON.stringify({
                    operation:
                        option === "--check"
                            ? "rotation_verified_without_changes"
                            : "rotation_committed_update_secret_before_restart",
                    counts,
                }) + "\n"
            );
        } else if (action === "migrate") {
            await migrate(connection.database, {
                migrationsFolder: authMigrationsFolder(),
            });
        } else if (action === "create-user") {
            const input = v.parse(newUserSchema, await privateInput());
            await connection.database.insert(users).values({
                id: input.id ?? crypto.randomUUID(),
                username: input.username,
                email: input.email,
                emailVerified: false,
                passwordHash: await hashPassword(input.password),
                groups: input.groups,
                createdAt: new Date(),
            });
        } else {
            const input = v.parse(recoverySchema, await privateInput());
            const passwordHash = await hashPassword(input.password);
            const accounts = new Accounts(connection.database, configuration);
            await connection.database.transaction(async (transaction) => {
                const [user] = await transaction
                    .select()
                    .from(users)
                    .where(eq(users.username, input.username))
                    .for("update");
                if (!user) throw new Error("Account not found");
                await transaction
                    .update(users)
                    .set({ passwordHash })
                    .where(eq(users.id, user.id));
                const inventory = await transaction
                    .select({ id: sessions.id })
                    .from(sessions)
                    .where(eq(sessions.userId, user.id));
                for (const session of inventory)
                    await accounts.revoke(transaction, session.id);
                await transaction
                    .delete(challenges)
                    .where(eq(challenges.userId, user.id));
                if (option === "--reset-mfa") {
                    await transaction.delete(factors).where(eq(factors.userId, user.id));
                    await transaction
                        .delete(recoveryCodes)
                        .where(eq(recoveryCodes.userId, user.id));
                }
                await audit(
                    transaction,
                    user.id,
                    option === "--reset-mfa"
                        ? "operator_mfa_recovery"
                        : "operator_password_recovery"
                );
            });
        }
        process.stdout.write(
            "Administrative operation completed. No credential values were logged.\n"
        );
    } finally {
        await connection.client.close();
    }
}
if (import.meta.main) {
    try {
        await runAdmin(process.argv.slice(2));
    } catch {
        process.stderr.write(
            "Administrative operation failed. Check the command, scoped configuration and private input; no input values were logged.\n"
        );
        process.exitCode = 1;
    }
}
