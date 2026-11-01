import { constants } from "node:fs";
import { open, readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";

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
 * Resolve the loopback lifecycle endpoint of an already driver-attested Chromium process.
 * @param pid - Trusted driver-owned PID, never an API or model argument.
 * @param expectedProfile - Exact saved-profile directory when persistence is enabled.
 * @param proc - Process metadata root; a synthetic root is only for tests.
 * @returns A local endpoint and a guard against PID reuse or process exit.
 */
export async function browserEndpoint(
    pid: number,
    expectedProfile?: string,
    proc = "/proc"
) {
    if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("Invalid browser process.");
    const identity = await processIdentity(pid, proc);
    const commandLine = await readFile(path.join(proc, String(pid), "cmdline"), "utf8");
    const args = commandLine.split("\0");
    const profiles = args.filter((arg) => arg.startsWith("--user-data-dir="));
    const profile = profiles[0]?.slice("--user-data-dir=".length);
    if (
        !identity ||
        profiles.length !== 1 ||
        !profile ||
        !path.isAbsolute(profile) ||
        (expectedProfile && profile !== expectedProfile) ||
        (await realpath(profile)) !== profile
    )
        throw new Error("The browser process profile could not be verified.");
    const directory = await lstat(profile);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.())
        throw new Error("Invalid browser profile ownership.");
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
    const alive = async () => (await processIdentity(pid, proc)) === identity;
    if (!(await alive())) throw new Error("Browser process exited during attachment.");
    return { url: `ws://127.0.0.1:${match[1]}${match[2]}`, alive };
}
