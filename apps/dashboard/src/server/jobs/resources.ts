/**
 * Coordinate integrations that mutate software on the same configured host.
 * @param hostname - Canonical deployment hostname shared by SSH and Docker endpoints.
 * @returns A bounded, opaque resource key; ports and integration-specific IDs do not split ownership.
 */
export function hostResourceKey(hostname: string): string {
    return `host:${new Bun.CryptoHasher("sha256").update(hostname.toLowerCase()).digest("hex")}`;
}
