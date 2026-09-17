import { timingSafeEqual } from "node:crypto";

/**
 * Create a purpose-prefixed opaque API token and its one-way verifier.
 * @returns One-time bearer material plus nonsecret selector and stored digest.
 */
export function issueAutomationToken() {
    const prefix = Bun.randomUUIDv7();
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url"
    );
    const token = `hlb_${prefix}.${secret}`;
    return { token, prefix, digest: digestAutomationToken(token) };
}

/**
 * Hash high-entropy token material without retaining plaintext credentials.
 * @param token - The complete opaque bearer token.
 * @returns Its SHA-256 verifier.
 */
export function digestAutomationToken(token: string): string {
    return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/**
 * Compare token verifiers in constant time after checking their fixed encoding.
 * @param actual - The presented token digest.
 * @param expected - A database verifier or dummy digest.
 * @returns Whether both digests are well-formed and identical.
 */
export function sameTokenDigest(actual: string, expected: string): boolean {
    return (
        /^[a-f0-9]{64}$/.test(actual) &&
        /^[a-f0-9]{64}$/.test(expected) &&
        timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
    );
}
