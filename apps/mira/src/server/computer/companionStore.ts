import { createHash } from "node:crypto";

import * as v from "valibot";

import { computerOrigin, type ComputerEnrollment } from "./companion";
import { readComputerCredential } from "./credentials";

const recordSchema = v.strictObject({
    id: v.pipe(v.string(), v.uuid()),
    credential: v.string(),
    expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    controlAllowed: v.literal(false),
});

/** Per-origin device credentials kept exclusively in the current user's OS credential store. */
export class ComputerCredentialStore {
    private readonly key: { service: string; name: string };
    private readonly vault: typeof Bun.secrets;

    /**
     * Select a dedicated, origin-bound key without reading any other application secrets.
     * @param origin - Explicit HTTPS dashboard origin.
     * @param vault - Native encrypted store, injectable for isolated tests.
     */
    constructor(origin: string, vault: typeof Bun.secrets = Bun.secrets) {
        this.key = {
            service: "no.rajohan.homelab.mira.computer",
            name: createHash("sha256").update(computerOrigin(origin)).digest("hex"),
        };
        this.vault = vault;
    }

    /**
     * Load and validate this dashboard's device credential without logging its contents.
     * @returns Saved pairing, or null when this origin has never been paired or was forgotten.
     */
    async read(): Promise<ComputerEnrollment | null> {
        let value: string | null;
        try {
            value = await this.vault.get(this.key);
        } catch {
            throw new Error("The operating system credential store is unavailable.");
        }
        if (value === null) return null;
        try {
            if (value.length > 1024) throw new Error("Invalid saved credential.");
            const record = v.parse(recordSchema, JSON.parse(value));
            if (readComputerCredential(record.credential, "device")?.id !== record.id)
                throw new Error("Invalid saved credential.");
            return record;
        } catch {
            throw new Error(
                "The saved computer pairing is invalid. Forget it and pair again."
            );
        }
    }

    /**
     * Save the issued credential with device-local persistence and no plaintext fallback.
     * @param record - Validated enrollment; a failure requires revoking the consumed ticket in Settings.
     * @returns Completion when the OS confirms the write and a read-back matches.
     */
    async save(record: ComputerEnrollment): Promise<void> {
        const checked = v.parse(recordSchema, record);
        if (readComputerCredential(checked.credential, "device")?.id !== checked.id)
            throw new Error("Invalid computer pairing.");
        const value = JSON.stringify(checked);
        try {
            await this.vault.set({ ...this.key, value, persist: "local" });
            if ((await this.vault.get(this.key)) !== value)
                throw new Error("Invalid saved credential.");
        } catch {
            throw new Error(
                "The pairing could not be saved. Revoke this computer in Settings before pairing again."
            );
        }
    }

    /**
     * Remove this origin's local credential; server revocation remains a separate Settings action.
     * @returns Completion after the OS removes the entry, including when already absent.
     */
    async forget(): Promise<void> {
        try {
            await this.vault.delete(this.key);
        } catch {
            throw new Error("The saved pairing could not be removed.");
        }
    }
}

/**
 * Forget local pairing, including the fixed Homelab service's retired HTTPS port.
 * @param origin - Explicit current HTTPS origin; other origins retain isolated removal.
 * @param vault - Current user's encrypted store, injectable for isolated tests.
 * @returns Completion only after all applicable entries are removed; no credential is read or transmitted.
 */
export async function forgetComputerPairing(
    origin: string,
    vault: typeof Bun.secrets = Bun.secrets
): Promise<void> {
    const canonical = computerOrigin(origin);
    await new ComputerCredentialStore(canonical, vault).forget();
    if (canonical === "https://computer.home.rajohan.no")
        await new ComputerCredentialStore(
            "https://computer.home.rajohan.no:3443",
            vault
        ).forget();
}
