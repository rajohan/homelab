import { createHash, randomBytes } from "node:crypto";

const tokenSchema =
    /^mira_(pair|device)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/**
 * Issue purpose-bound, high-entropy material shown only to the enrolling party.
 * @param purpose - One-use pairing ticket or scoped device credential.
 * @param id - Server-created computer selector, not an owner identity.
 * @returns Plaintext for one delivery and its SHA-256 verifier for durable storage.
 */
export function issueComputerCredential(purpose: "pair" | "device", id: string) {
    const token = `mira_${purpose}_${id}.${randomBytes(32).toString("base64url")}`;
    return { token, digest: createHash("sha256").update(token).digest("hex") };
}

/**
 * Parse a purpose-specific credential without exposing its material in errors.
 * @param token - Opaque bearer material received outside URLs and cookies.
 * @param purpose - The only credential kind accepted by the selected endpoint.
 * @returns A bounded selector and hash, or null before any database lookup.
 */
export function readComputerCredential(token: string, purpose: "pair" | "device") {
    const match = tokenSchema.exec(token);
    if (!match || match[1] !== purpose) return null;
    return { id: match[2]!, digest: createHash("sha256").update(token).digest("hex") };
}
