import type { UpdateItem } from "@homelab/contracts/updates";
import * as v from "valibot";

import type { UpdateTarget } from "./configuration";
import program from "./remote.py" with { type: "text" };

const phases = {
    checking: "Checking the installed version and update target.",
    pulling: "Downloading the approved image without changing the running application.",
    configuring: "Saving the new image pin in Compose.",
    installing: "Installing the approved version.",
    verifying: "Verifying the installed version and application health.",
} as const;
const eventSchema = v.variant("complete", [
    v.object({
        complete: v.literal(true),
        installed: v.pipe(v.string(), v.maxLength(300)),
        rebootRequired: v.boolean(),
        containerId: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
    }),
    v.object({ complete: v.literal(false) }),
]);
const progressSchema = v.object({
    phase: v.picklist(Object.keys(phases) as (keyof typeof phases)[]),
});
export interface UpdateReceipt {
    readonly installed: string;
    readonly rebootRequired: boolean;
    readonly containerId?: string;
}
export type UpdateExecutor = (
    target: UpdateTarget,
    item: UpdateItem,
    automatic: boolean,
    signal: AbortSignal,
    report: (message: string) => Promise<void>
) => Promise<UpdateReceipt>;
const quote = (value: string) => "'" + value.replaceAll("'", String.raw`'\''`) + "'";

/**
 * Build an SSH invocation with explicit host-key verification and no agent/config inheritance.
 * @param target - Deployment-owned host, user and read-only mounted identity/trust paths.
 * @returns Argument vector; software data travels on stdin, never inside a shell command.
 */
export function updateSshArguments(target: UpdateTarget): string[] {
    const remote = `${target.sudo ? "sudo -n " : ""}/usr/bin/python3 -c ${quote(program)}`;
    return [
        "/usr/bin/ssh",
        "-F",
        "/dev/null",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        `UserKnownHostsFile=${target.knownHostsFile}`,
        "-i",
        target.identityFile,
        "-p",
        String(target.port),
        "-l",
        target.user,
        "--",
        target.host,
        remote,
    ];
}

/**
 * Run one approved update through a transient fixed program; never retain raw command output.
 * @param target - Exact deployment target, separate from read-only collection access.
 * @param item - Revalidated version observation and immutable candidate.
 * @param automatic - Whether dependency admission must also reject majors/unknown versions.
 * @param signal - Live worker claim, cancellation and deadline.
 * @param report - Fenced, code-owned progress sink.
 * @returns A verified version receipt; a failure may have partially changed the target.
 */
export const executeUpdate: UpdateExecutor = async (
    target,
    item,
    automatic,
    signal,
    report
) => {
    signal.throwIfAborted();
    const process = Bun.spawn(updateSshArguments(target), {
        stdin: new TextEncoder().encode(
            JSON.stringify({ driver: target.driver, item, automatic })
        ),
        stdout: "pipe",
        stderr: "ignore",
        signal,
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
    });
    let receipt: UpdateReceipt | undefined;
    let bytes = 0;
    let pending = "";
    try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for await (const chunk of process.stdout) {
            bytes += chunk.byteLength;
            if (bytes > 65_536) throw new Error("Update receipt exceeded its budget");
            pending += decoder.decode(chunk, { stream: true });
            let end = pending.indexOf("\n");
            while (end !== -1) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                const value: unknown = JSON.parse(line);
                const phase = v.safeParse(progressSchema, value);
                if (phase.success) {
                    if (receipt)
                        throw new Error("Unexpected update event after completion");
                    await report(phases[phase.output.phase]);
                } else {
                    const event = v.parse(eventSchema, value);
                    if (!event.complete || receipt)
                        throw new Error("Update execution did not complete");
                    receipt = {
                        installed: event.installed,
                        rebootRequired: event.rebootRequired,
                        ...(event.containerId ? { containerId: event.containerId } : {}),
                    };
                }
                end = pending.indexOf("\n");
            }
        }
        pending += decoder.decode();
        if (
            (await process.exited) !== 0 ||
            pending.trim() ||
            !receipt ||
            receipt.installed !== item.available
        )
            throw new Error("Update execution could not be verified");
        return receipt;
    } finally {
        if (process.exitCode === null) process.kill();
        await process.exited;
    }
};
