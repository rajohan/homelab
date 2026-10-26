import { ComputerCredentialStore } from "../computer/companionStore";
import { issueComputerCredential } from "../computer/credentials";

/**
 * Qualify the real OS vault using one random synthetic origin, then delete only that entry.
 * @returns Completion after save/read/local deletion; no credential material is printed.
 */
export async function main(): Promise<void> {
    const id = crypto.randomUUID();
    const store = new ComputerCredentialStore(`https://${id}.invalid`);
    if ((await store.read()) !== null)
        throw new Error("Synthetic vault key unexpectedly exists.");
    try {
        const record = {
            id,
            credential: issueComputerCredential("device", id).token,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            controlAllowed: false as const,
        };
        await store.save(record);
        const saved = await store.read();
        if (saved?.credential !== record.credential)
            throw new Error("Synthetic vault read did not match.");
    } finally {
        await store.forget();
    }
    if ((await store.read()) !== null) throw new Error("Synthetic vault cleanup failed.");
    process.stdout.write(
        JSON.stringify({
            platform: process.platform,
            vault: "verified",
            cleanup: "verified",
        }) + "\n"
    );
}
if (import.meta.main) await main();
