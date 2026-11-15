import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { executeMiraHostCommand, MiraHostCommandFailure } from "./ssh";

const target = {
    id: "fixture",
    label: "Fixture",
    host: "127.0.0.1",
    port: 22,
    user: "fixture",
    identityFile: "/fixture/key",
    knownHostsFile: "/fixture/hosts",
};
const command = {
    target: "fixture",
    command: "printf 'literal $HOME; `echo do-not-interpret`'",
    reason: "Transport qualification",
    timeoutSeconds: 5,
};

function child(program: string, stdin: Uint8Array) {
    return Bun.spawn([process.execPath, "-e", program], {
        stdin,
        stdout: "pipe",
        stderr: "pipe",
    });
}

test("host transport sends literal stdin, retains observed exit codes and drains bounded UTF-8 output", async () => {
    const result = await executeMiraHostCommand(
        target,
        command,
        new AbortController().signal,
        (args, stdin) => {
            expect(args.at(-1)).toBe("sh -s");
            expect(new TextDecoder().decode(stdin)).toBe(command.command + "\n");
            return child(
                "await Bun.stdin.text(); process.stdout.write('ø'.repeat(40000)); process.stderr.write('synthetic diagnostic');",
                stdin
            );
        }
    );
    expect(result).toEqual({
        exitCode: 0,
        stdout: "ø".repeat(32_000),
        stderr: "synthetic diagnostic",
        truncated: true,
        trust: "untrusted_host_output",
    });
});

test("an observed nonzero command is a known failure with bounded private diagnostics", async () => {
    await rejects(executeMiraHostCommand(target, command, new AbortController().signal, (_args, stdin) => child("process.stdout.write('partial'); process.stderr.write('failure detail'); process.exitCode=7;", stdin)), (error: unknown) => {
        expect(error).toBeInstanceOf(MiraHostCommandFailure);
        const failure = error as MiraHostCommandFailure;
        expect(failure.result).toMatchObject({ exitCode: 7, stdout: "partial", stderr: "failure detail" });
        expect(failure.message).not.toContain("failure detail");
        return true;
    });
});

test("SSH disconnect is uncertain and is never retried", async () => {
    let attempts = 0;
    await rejects(
        executeMiraHostCommand(
            target,
            command,
            new AbortController().signal,
            (_args, stdin) => {
                attempts++;
                return child("process.exit(255)", stdin);
            }
        ),
        /not confirmed/
    );
    expect(attempts).toBe(1);
});

test.each(["stop", "deadline"])(
    "%s reaps the transport without claiming the remote action was undone",
    async (kind) => {
        const controller = new AbortController();
        let process: ReturnType<typeof child> | undefined;
        const pending = executeMiraHostCommand(
            target,
            { ...command, timeoutSeconds: 1 },
            controller.signal,
            (_args, stdin) => {
                process = child("setInterval(() => {}, 10000)", stdin);
                return process;
            }
        );
        if (kind === "stop") controller.abort();
        await rejects(pending);
        expect(await process?.exited).not.toBe(0);
        expect(process?.signalCode).toBe("SIGKILL");
    }
);

test("an already stopped run never starts SSH", async () => {
    let started = false;
    await rejects(
        executeMiraHostCommand(target, command, AbortSignal.abort(), (_args, stdin) => {
            started = true;
            return child("process.exit(0)", stdin);
        })
    );
    expect(started).toBe(false);
});
