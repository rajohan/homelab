import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import { browserProfileDirectory } from "./profile";

async function processIdentity(pid: number, proc: string) {
    const text = await readFile(path.join(proc, String(pid), "stat"), "utf8").catch(
        () => ""
    );
    const fields = text
        .slice(text.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
    return fields[0] === "Z" || !/^\d+$/u.test(fields[19] ?? "") ? null : fields[19];
}

/**
 * Capture a close-only endpoint after the native driver attests its own browser PID.
 * @param pid - The verified driver-launched Chromium process in this container.
 * @param directory - Fixed private profile root; temporary storage is for qualification only.
 * @param proc - Linux process metadata root; synthetic metadata is for tests only.
 * @returns A bounded normal-close attempt, followed by the caller's unconditional SDK shutdown.
 */
export async function prepareBrowserProfileShutdown(
    pid: number,
    directory = browserProfileDirectory,
    proc = "/proc"
): Promise<() => Promise<void>> {
    if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("Invalid browser process.");
    const profile = path.join(directory, "saved");
    const identity = await processIdentity(pid, proc);
    const commandLine = await readFile(path.join(proc, String(pid), "cmdline"), "utf8");
    const args = commandLine.split("\0");
    if (!identity || !args.includes(`--user-data-dir=${profile}`))
        throw new Error("The saved browser process could not be verified.");
    const file = await open(
        path.join(profile, "DevToolsActivePort"),
        constants.O_RDONLY | constants.O_NOFOLLOW
    );
    let content: string;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 256)
            throw new Error("Invalid browser lifecycle marker.");
        const buffer = Buffer.alloc(257);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await file.close();
    }
    const match = /^(\d{1,5})\n(\/devtools\/browser\/[a-f0-9-]{36})\n?$/u.exec(content);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535)
        throw new Error("Invalid browser lifecycle endpoint.");
    // There is no arbitrary CDP interface: one fixed, parameterless lifecycle
    // command goes to this container's attested browser, never a remote URL.
    const endpoint = `ws://127.0.0.1:${match[1]}${match[2]}`;
    return async () => {
        if ((await processIdentity(pid, proc)) !== identity) return;
        await new Promise<void>((resolve) => {
            const socket = new WebSocket(endpoint);
            let finished = false;
            const timer = setTimeout(finish, 1200);
            const poll = setInterval(() => {
                void processIdentity(pid, proc).then((current) => {
                    if (current !== identity) finish();
                    return current;
                });
            }, 25);
            function finish() {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                clearInterval(poll);
                socket.close();
                resolve();
            }
            socket.addEventListener("open", () =>
                socket.send('{"id":1,"method":"Browser.close"}')
            );
            socket.addEventListener("error", finish);
            // A closed CDP socket alone does not prove that Chromium has flushed
            // its profile. Wait for this exact process to exit, within the bound.
        });
    };
}
