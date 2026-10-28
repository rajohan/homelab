import path from "node:path";

import { version } from "../../../../../package.json";
import { computerEnvironment } from "../config/environment";
import { ComputerCompanion, computerOrigin } from "./companion";
import { readComputerTicket } from "./companionInput";
import { watchComputerParent } from "./companionParent";
import { runComputerPresence } from "./companionPresence";
import { ComputerCredentialStore } from "./companionStore";
import { computerConnectionWork } from "./companionWork";
import { openComputerInstallationLease } from "./installationLease";
import { installedComputerHost, readComputerPackage } from "./installedComputer";

function print(message: string) {
    process.stdout.write(message + "\n");
}
function printError(message: string) {
    process.stderr.write(message + "\n");
}

const usage = `Mira computer companion ${version}
Usage: mira-computer <pair|run|forget> https://dashboard.example.com
       mira-computer --version

Pair reads a private, single-use code from Settings > Computers.
Run keeps the connection open until Ctrl+C. Windows waits for a Chat request and
local approval of one window. Other platforms support presence only.
Forget removes the local credential. Revoke in Settings to disconnect existing clients.`;

/**
 * Run the packaged outbound companion with explicit arguments and the current user's OS vault.
 * @param args - Command and HTTPS origin; credentials are never accepted as arguments.
 * @returns Completion after pairing, forgetting or the operator stops the connection and local resources are reaped.
 */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
    if (args.length === 1 && args[0] === "--version") {
        print(version);
        return;
    }
    if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
        print(usage);
        return;
    }
    const [command, suppliedOrigin, mode] = args;
    const supervised = command === "run" && mode === "--supervised" && args.length === 3;
    if (
        (args.length !== 2 && !supervised) ||
        !["pair", "run", "forget"].includes(command ?? "") ||
        !suppliedOrigin
    )
        throw new Error(
            "Use --help for companion commands. Never pass a pairing code as an argument."
        );
    const origin = computerOrigin(suppliedOrigin);
    if (supervised && process.stdin.isTTY)
        throw new Error(
            "A supervised connection requires the Windows launcher's private input pipe."
        );
    const store = new ComputerCredentialStore(origin);
    const stopped = new AbortController();
    const stop = () => stopped.abort();
    const detachParent = supervised
        ? watchComputerParent(process.stdin, stop)
        : undefined;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let lease: Awaited<ReturnType<typeof openComputerInstallationLease>> | undefined;
    try {
        stopped.signal.throwIfAborted();
        if (process.platform === "win32") {
            const directory = await readComputerPackage(process.execPath);
            lease = await openComputerInstallationLease({
                command: path.join(directory, "mira-computer-desktop.exe"),
                args: ["--installation-lease"],
                cwd: directory,
                environment: computerEnvironment(),
            });
            lease.signal.addEventListener("abort", stop, { once: true });
            if (lease.signal.aborted) stop();
            stopped.signal.throwIfAborted();
        }
        if (command === "forget") {
            await store.forget();
            print(
                "Local pairing removed. Revoke the computer in Settings to end existing connections."
            );
            return;
        }
        const createHost =
            command === "run" && process.platform === "win32"
                ? await installedComputerHost(origin, process.execPath)
                : undefined;
        const existing = await store.read();
        stopped.signal.throwIfAborted();
        const companion = new ComputerCompanion(origin);
        if (command === "pair") {
            if (existing)
                throw new Error(
                    "This server is already paired. Revoke in Settings and forget locally before replacing it."
                );
            print(`Pairing with ${origin}`);
            process.stdout.write("Pairing code (hidden): ");
            const ticket = await readComputerTicket(process.stdin, stopped.signal);
            process.stdout.write("\n");
            let record;
            try {
                record = await companion.enroll(
                    ticket,
                    {
                        installationId: crypto.randomUUID(),
                        platform: process.platform,
                        version,
                    },
                    stopped.signal
                );
            } catch {
                throw new Error(
                    "Pairing was not confirmed. Revoke the ticket in Settings and create a new one before retrying."
                );
            }
            await store.save(record);
            print(
                "Paired. Start the companion with the run command when you want to connect."
            );
        } else {
            if (!existing)
                throw new Error(
                    "Pair this server first using a code from Settings > Computers."
                );
            await runComputerPresence({
                companion,
                credential: existing.credential,
                expiresAt: existing.expiresAt,
                ...(createHost
                    ? {
                          connectionWork: computerConnectionWork({
                              companion,
                              credential: existing.credential,
                              createHost,
                          }),
                      }
                    : {}),
                signal: stopped.signal,
                status: (state) =>
                    print(
                        {
                            connected: "Connected. Press Ctrl+C to stop.",
                            reconnecting:
                                "Connection interrupted. Retrying in 30 seconds.",
                            stopped: "Computer connection stopped.",
                        }[state]
                    ),
            });
        }
    } finally {
        stopped.abort();
        detachParent?.();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        lease?.signal.removeEventListener("abort", stop);
        await lease?.close();
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        printError(error instanceof Error ? error.message : "Computer companion failed.");
        process.exitCode = 1;
    }
}
