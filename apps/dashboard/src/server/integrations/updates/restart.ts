import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import type { UpdateTarget } from "./configuration";
import { updateSshArguments } from "./execution";
import { recordRestartObservation } from "./restartObservation";

const program = `import json, os
try:
    os.stat('/var/run/reboot-required')
    required = True
except FileNotFoundError:
    required = False
except OSError:
    required = None
print(json.dumps(required))
`;

/**
 * Observe the distribution restart flag without running an update or reboot command.
 * @param target - Existing deployment-owned SSH trust and host.
 * @param signal - Worker cancellation and bounded observation deadline.
 * @returns The flag, or null when it cannot be verified.
 */
export async function readRestartRequired(
    target: UpdateTarget,
    signal: AbortSignal
): Promise<boolean | null> {
    signal.throwIfAborted();
    const process = Bun.spawn(updateSshArguments(target, program), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        signal,
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
    });
    try {
        let output = "";
        for await (const bytes of process.stdout) {
            if (output.length + bytes.length > 100)
                throw new Error("Restart observation exceeded its budget");
            output += new TextDecoder().decode(bytes);
        }
        if ((await process.exited) !== 0) return null;
        return v.parse(v.nullable(v.boolean()), JSON.parse(output) as unknown);
    } finally {
        if (process.exitCode === null) process.kill();
        await process.exited;
    }
}

/**
 * Keep host restart requirements current, including updates performed outside the dashboard.
 * @param targets - Approved host connections; duplicate application targets share one probe.
 * @param inspect - Read-only SSH boundary, replaceable by an isolated test fixture.
 * @returns A minute-cadence job which records unavailable probes explicitly as unknown.
 */
export function restartStatusJob(
    targets: readonly UpdateTarget[],
    inspect = readRestartRequired
): JobHandler {
    const sources = [
        ...new Map(targets.map((target) => [target.source, target])).values(),
    ];
    const ambiguous = new Set(
        sources
            .filter((source) =>
                targets.some(
                    (target) =>
                        target.source === source.source &&
                        target.host.toLowerCase() !== source.host.toLowerCase()
                )
            )
            .map((source) => source.source)
    );
    return {
        definition: {
            key: "updates.restart-status",
            label: "Check host restart requirements",
            description:
                "Read host restart flags without changing software or restarting services.",
            resourceClass: "network",
            capability: "updates:refresh",
            resourceKeys: ["snapshot:updates-restart"],
            timeoutMs: Math.max(60_000, Math.ceil(sources.length / 4) * 15_000 + 5000),
            attemptLimit: 1,
            retrySafe: true,
            intervalSeconds: 60,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_payload, context) => {
            let index = 0;
            const lane = async () => {
                while (index < sources.length) {
                    const target = sources[index++];
                    if (!target) return;
                    context.signal.throwIfAborted();
                    const observedAt = new Date().toISOString();
                    let required: boolean | null = null;
                    try {
                        if (!ambiguous.has(target.source))
                            required = await inspect(
                                target,
                                AbortSignal.any([
                                    context.signal,
                                    AbortSignal.timeout(15_000),
                                ])
                            );
                    } catch {
                        context.signal.throwIfAborted();
                    }
                    if (
                        !(await context.commit(async (transaction) => {
                            await recordRestartObservation(
                                transaction,
                                target.source,
                                required,
                                observedAt
                            );
                        }))
                    )
                        throw new Error("Restart observation ownership changed");
                }
            };
            await Promise.all(Array.from({ length: 4 }, lane));
        },
    };
}
