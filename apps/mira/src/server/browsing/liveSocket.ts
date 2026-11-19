import path from "node:path";

import * as v from "valibot";

const uuid = v.pipe(v.string(), v.uuid());
export const browserLiveIdentitySchema = v.strictObject({
    owner: uuid,
    accessId: uuid,
    epoch: uuid,
});

/** Resolve a private host socket inside the existing shared Mira storage.
 * @param directory - Trusted attachment directory from service configuration.
 * @param hostId - Database-resolved browser host identity.
 * @returns A fixed local IPC path, never a network address or browser-selected path.
 */
export function browserLiveSocket(directory: string, hostId: string): string {
    v.parse(uuid, hostId);
    if (!path.isAbsolute(directory)) throw new Error("Browser storage must be absolute.");
    return path.join(directory, ".browser-live", hostId + ".sock");
}
