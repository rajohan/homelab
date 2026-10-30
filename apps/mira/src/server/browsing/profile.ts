import * as v from "valibot";

export const browserProfileSchema = v.strictObject({ id: v.pipe(v.string(), v.uuid()) });
export type BrowserProfile = v.InferOutput<typeof browserProfileSchema>;
export const browserProfileDirectory = "/var/lib/mira-browser-profile";
export const browserProfileMemoryBytes = 64 * 1024 * 1024;
export const browserProfileSnapshotBytes = 25 * 1024 * 1024;
export const browserProfileCapacity = 16;

/** Private host persistence; neither the model nor human APIs receive snapshot content. */
export interface BrowserProfilePersistence {
    snapshot: string | null;
    /** Commit one validated snapshot only while this process still owns its cleanup lease. */
    save: (snapshot: string) => Promise<void>;
}
