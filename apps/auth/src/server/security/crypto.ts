import { createCipheriv, createDecipheriv } from "node:crypto";

import { AuthFailure } from "./errors";

/**
 * Generate an opaque token from 32 cryptographically random bytes.
 * @returns The URL-safe base64 token.
 */
export function randomToken(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/**
 * Hash opaque tokens for deterministic lookup without storing their plaintext.
 * @param value - The token or purpose-prefixed lookup input.
 * @returns The hexadecimal SHA-256 digest.
 */
export function tokenDigest(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

// A versioned AEAD envelope binds ciphertext to its intended record/purpose.
/**
 * Seal JSON in a versioned AES-GCM envelope bound to its record purpose.
 * @param key - The 32-byte encryption key.
 * @param purpose - The authenticated record purpose, including its identifier.
 * @param value - The JSON-serializable value to protect.
 * @returns The versioned nonce, tag and ciphertext envelope.
 */
export function encryptValue(key: Uint8Array, purpose: string, value: unknown): string {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
    ]);
    return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
    ].join(".");
}

/**
 * Authenticate and decode a versioned encrypted record.
 * @param key - The key that encrypted the record.
 * @param purpose - The exact authenticated record purpose.
 * @param envelope - The stored versioned ciphertext.
 * @returns The decoded JSON value; callers still validate its schema.
 * @throws {Error} The envelope, key, purpose, authentication tag or JSON is invalid.
 */
export function decryptValue(
    key: Uint8Array,
    purpose: string,
    envelope: string
): unknown {
    const [version, nonce, tag, ciphertext, extra] = envelope.split(".");
    if (version !== "v1" || !nonce || !tag || !ciphertext || extra !== undefined) {
        throw new Error("Invalid encrypted record");
    }
    const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(nonce, "base64url")
    );
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
    ]);
    return JSON.parse(plaintext.toString()) as unknown;
}

let passwordWork = 0;
async function boundedPasswordWork<T>(operation: () => Promise<T>): Promise<T> {
    if (passwordWork >= 4)
        throw new AuthFailure("BUSY", 503, "Authentication is busy. Try again shortly.");
    passwordWork += 1;
    try {
        return await operation();
    } finally {
        passwordWork -= 1;
    }
}
/**
 * Hash a password with Argon2id through the bounded password-work queue.
 * @param password - The plaintext password, retained only for this operation.
 * @returns The encoded password hash.
 */
export function hashPassword(password: string): Promise<string> {
    return boundedPasswordWork(() =>
        Bun.password.hash(password, {
            algorithm: "argon2id",
            memoryCost: 65_536,
            timeCost: 3,
        })
    );
}
/**
 * Verify a password through the bounded password-work queue.
 * @param password - The candidate plaintext password.
 * @param hash - The stored encoded password hash.
 * @returns Whether the candidate matches.
 */
export function verifyPassword(password: string, hash: string): Promise<boolean> {
    return boundedPasswordWork(() => Bun.password.verify(password, hash));
}
