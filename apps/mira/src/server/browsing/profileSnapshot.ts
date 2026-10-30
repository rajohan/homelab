import { constants } from "node:fs";
import { mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import * as v from "valibot";

import {
    browserProfileDirectory,
    browserProfileMemoryBytes,
    browserProfileSnapshotBytes,
} from "./profile";

const runtime = new Set([
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "DevToolsActivePort",
]);
const entriesSchema = v.pipe(
    v.array(
        v.strictObject({
            name: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
            data: v.string(),
        })
    ),
    v.maxLength(5000)
);
const rawLimit = 96 * 1024 * 1024;

function relativeName(name: string) {
    const parts = name.split("/");
    if (
        parts.length > 32 ||
        parts.some((part) => !part || part === "." || part === "..") ||
        /[\\\p{Cc}]/u.test(name) ||
        runtime.has(parts[0]!)
    )
        throw new Error("Invalid saved browser file name.");
    return name;
}
function decode(data: string, limit: number) {
    if (data.length > (limit * 4) / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data))
        throw new Error("Browser profile snapshot exceeds its limit.");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > limit || bytes.toString("base64") !== data)
        throw new Error("Invalid browser profile encoding.");
    return bytes;
}

/**
 * Validate a bounded compressed profile without extracting paths or exposing content.
 * @param snapshot - Private base64 gzip snapshot, never an agent result.
 * @returns Validated regular-file records within the same 64 MiB runtime quota.
 */
export function browserProfileSnapshot(snapshot: string) {
    if (snapshot.length > browserProfileSnapshotBytes)
        throw new Error("Browser profile snapshot exceeds its limit.");
    const decoded = gunzipSync(decode(snapshot, browserProfileSnapshotBytes), {
        maxOutputLength: rawLimit,
    });
    const records = v.parse(
        entriesSchema,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded))
    );
    const names = new Set<string>();
    let total = 0;
    for (const record of records) {
        relativeName(record.name);
        if (names.has(record.name)) throw new Error("Repeated browser profile file.");
        names.add(record.name);
        total += decode(record.data, browserProfileMemoryBytes).length;
        if (total > browserProfileMemoryBytes)
            throw new Error("Browser profile snapshot exceeds its limit.");
    }
    for (const name of names) {
        const parts = name.split("/");
        for (let index = 1; index < parts.length; index++)
            if (names.has(parts.slice(0, index).join("/")))
                throw new Error("Conflicting browser profile paths.");
    }
    return records;
}

/**
 * Restore only validated regular files into a new private tmpfs before Chromium starts.
 * @param snapshot - Previously validated private database value, or null for a new profile.
 * @param directory - Fixed tmpfs root; temporary roots are used by qualification only.
 * @returns Completion after exclusive creation; existing files, links and traversal are refused.
 */
export async function restoreBrowserProfile(
    snapshot: string | null,
    directory = browserProfileDirectory
): Promise<void> {
    if (snapshot === null) return;
    const records = browserProfileSnapshot(snapshot);
    const root = path.join(directory, "saved");
    await mkdir(root, { mode: 0o700 });
    for (const record of records) {
        const target = path.join(root, record.name);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const file = await open(
            target,
            constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
            0o600
        );
        try {
            await file.writeFile(Buffer.from(record.data, "base64"));
        } finally {
            await file.close();
        }
    }
}

/**
 * Capture a stopped Chromium profile from its quota-enforced tmpfs, excluding runtime links.
 * @param directory - Fixed private tmpfs root; temporary roots are used by qualification only.
 * @returns A bounded private snapshot for the host's atomic database update.
 */
export async function captureBrowserProfile(
    directory = browserProfileDirectory
): Promise<string> {
    const root = await open(
        path.join(directory, "saved"),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const records: { name: string; data: string }[] = [];
    let total = 0,
        visited = 0;
    const walk = async (parent: FileHandle, prefix: string, owner: number) => {
        // The Linux worker pins every ancestor by descriptor. A renamed directory
        // or substituted link cannot redirect later opens outside this profile.
        const pinned = `/proc/self/fd/${parent.fd}`;
        for (const name of await readdir(pinned)) {
            if (!prefix && runtime.has(name)) continue;
            if (++visited > 5000)
                throw new Error("Browser profile has too many entries.");
            const relative = relativeName(prefix + name);
            const file = await open(
                path.join(pinned, name),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            ).catch(() => {
                throw new Error("Unsupported browser profile entry.");
            });
            try {
                const stat = await file.stat();
                if (stat.uid !== owner) throw new Error("Invalid browser profile owner.");
                if (stat.isDirectory()) {
                    await walk(file, relative + "/", owner);
                    continue;
                }
                if (
                    !stat.isFile() ||
                    stat.nlink !== 1 ||
                    stat.size > browserProfileMemoryBytes
                )
                    throw new Error("Unsupported browser profile entry.");
                total += stat.size;
                if (total > browserProfileMemoryBytes)
                    throw new Error("Browser profile exceeds its limit.");
                const bytes = Buffer.alloc(stat.size + 1);
                let offset = 0;
                while (offset < bytes.length) {
                    const read = await file.read(
                        bytes,
                        offset,
                        bytes.length - offset,
                        offset
                    );
                    if (!read.bytesRead) break;
                    offset += read.bytesRead;
                }
                const after = await file.stat();
                if (
                    offset !== stat.size ||
                    after.size !== stat.size ||
                    after.mtimeMs !== stat.mtimeMs ||
                    after.ctimeMs !== stat.ctimeMs ||
                    after.nlink !== 1
                )
                    throw new Error("Browser profile changed during capture.");
                records.push({
                    name: relative,
                    data: bytes.subarray(0, offset).toString("base64"),
                });
            } finally {
                await file.close();
            }
        }
    };
    try {
        const metadata = await root.stat();
        if (!metadata.isDirectory() || metadata.uid !== process.getuid?.())
            throw new Error("Invalid browser profile root.");
        await walk(root, "", metadata.uid);
    } finally {
        await root.close();
    }
    const raw = JSON.stringify(records);
    if (Buffer.byteLength(raw) > rawLimit)
        throw new Error("Browser profile snapshot exceeds its limit.");
    const snapshot = gzipSync(raw).toString("base64");
    browserProfileSnapshot(snapshot);
    return snapshot;
}
