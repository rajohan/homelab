import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";
import * as v from "valibot";

export const daytonaCheckSchema = v.strictObject({
    id: v.pipe(v.string(), v.uuid()),
    commit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    patchSha256: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
});
export type DaytonaCheckRequest = v.InferOutput<typeof daytonaCheckSchema>;
export const daytonaCheckProfile = Object.freeze({
    version: 1,
    repository: "https://github.com/rajohan/homelab.git",
    bunVersion: "1.4.4",
    executable: "/opt/homelab/daytona-check.js",
    minutes: 10,
    collectionSeconds: 120,
    outputs: ["check-result.json", "check-log.txt", "changes.txt"],
});

/**
 * Construct an exact, reviewable command for the fixed Homelab verification profile.
 * @param request - Durable job UUID, public commit and optional immutable patch digest.
 * @param patch - Previously authorized conversation attachment, if a patch was selected.
 * @returns Ordinary cloud proposal; it grants no execution, spend, GitHub or deployment authority.
 */
export function daytonaCheckContent(
    request: DaytonaCheckRequest,
    patch?: { id: string; sha256: string }
): MiraDaytonaContent {
    const parsed = v.parse(daytonaCheckSchema, request);
    if (
        (parsed.patchSha256 !== null) !== !!patch ||
        (patch && patch.sha256 !== parsed.patchSha256)
    )
        throw new Error("Patch digest does not match the selected input.");
    return {
        title: `Check Homelab ${parsed.commit.slice(0, 12)}`,
        command: `bun --no-env-file ${daytonaCheckProfile.executable} ${parsed.id} ${parsed.commit}${parsed.patchSha256 ? ` ${parsed.patchSha256}` : ""}`,
        inputs: patch ? [{ ...patch, name: "changes.txt" }] : [],
        outputs: [...daytonaCheckProfile.outputs],
    };
}

/**
 * Reserve the fixed check duration and result collection before dispatching a referenced harness command.
 * @param command - Exact approved command; referencing the harness conservatively reserves its full budget.
 * @returns Minimum milliseconds remaining in both local admission and provider lifetime. This grants no authority.
 */
export function daytonaCheckMinimumLifetime(command: string): number {
    return command.includes(daytonaCheckProfile.executable)
        ? (daytonaCheckProfile.minutes * 60 + daytonaCheckProfile.collectionSeconds) *
              1000
        : 30_000;
}
