import * as v from "valibot";

const label = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(80),
    v.check((value) => {
        for (const char of value) {
            const point = char.codePointAt(0)!;
            if (point < 32 || point === 127) return false;
        }
        return true;
    })
);
export const miraComputerPairSchema = v.strictObject({ label });
export const miraComputerEnrollmentSchema = v.strictObject({
    installationId: v.pipe(v.string(), v.uuid()),
    platform: v.picklist(["win32", "linux", "darwin"]),
    version: v.pipe(
        v.string(),
        v.regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,40})?$/)
    ),
});
export const miraComputerHeartbeatSchema = v.strictObject({
    connectionId: v.pipe(v.string(), v.uuid()),
    sequence: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_647)),
});
export interface MiraComputerSummary {
    id: string;
    label: string;
    version: number;
    state: "pending" | "paired" | "revoked";
    platform: string | null;
    companionVersion: string | null;
    pairedAt: string | null;
    expiresAt: string;
    lastSeenAt: string | null;
    connected: boolean;
}
