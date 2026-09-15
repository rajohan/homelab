import { createCipheriv, createDecipheriv } from "node:crypto";

import { AuthFailure } from "./errors";

export function randomToken(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function tokenDigest(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

// A versioned AEAD envelope binds ciphertext to its intended record/purpose.
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
export function hashPassword(password: string): Promise<string> {
    return boundedPasswordWork(() =>
        Bun.password.hash(password, {
            algorithm: "argon2id",
            memoryCost: 65_536,
            timeCost: 3,
        })
    );
}
export function verifyPassword(password: string, hash: string): Promise<boolean> {
    return boundedPasswordWork(() => Bun.password.verify(password, hash));
}
