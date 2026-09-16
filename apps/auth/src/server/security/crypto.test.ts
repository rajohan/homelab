import { describe, expect, test } from "bun:test";

import {
    decryptValue,
    encryptValue,
    hashPassword,
    randomToken,
    tokenDigest,
    verifyPassword,
} from "./crypto";

describe("identity cryptography", () => {
    test("encrypts sensitive records with purpose binding and randomized nonces", () => {
        const key = crypto.getRandomValues(new Uint8Array(32));
        const value = { secret: "test-only-factor" };
        const envelope = encryptValue(key, "factor:one", value);
        expect(decryptValue(key, "factor:one", envelope)).toEqual(value);
        expect(encryptValue(key, "factor:one", value)).not.toBe(envelope);
        expect(() => decryptValue(key, "factor:two", envelope)).toThrow();
        expect(() => decryptValue(new Uint8Array(32), "factor:one", envelope)).toThrow();
    });
    test("generates independent opaque tokens and fixed-length digests", () => {
        const token = randomToken();
        expect(token).toHaveLength(43);
        expect(randomToken()).not.toBe(token);
        expect(tokenDigest(token)).toHaveLength(64);
    });
    test("keeps token digests compatible with the stored SHA-256 format", () => {
        expect(tokenDigest("")).toBe(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        expect(tokenDigest("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });
    test("uses Argon2id and rejects incorrect passwords", async () => {
        const hash = await hashPassword("isolated test password");
        expect(hash.startsWith("$argon2id$")).toBe(true);
        expect(await verifyPassword("isolated test password", hash)).toBe(true);
        expect(await verifyPassword("incorrect password", hash)).toBe(false);
    });
});
