import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    miraComputerUpdateSchema,
    miraComputerUpdateUrl,
    type MiraComputerUpdate,
} from "@homelab/contracts/miraComputerUpdates";
import * as v from "valibot";

import { fetchComputer, type ComputerFetch } from "./companion";

function newerVersion(installed: string, available: string): boolean {
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(installed))
        throw new Error("The installed client version is not a stable release.");
    const before = installed.split(".").map(Number);
    const after = available.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
        if (before[index] !== after[index]) return before[index]! < after[index]!;
    }
    return false;
}
function sameRelease(before: MiraComputerUpdate, after: MiraComputerUpdate): boolean {
    return (
        before.repository === after.repository &&
        before.version === after.version &&
        before.revision === after.revision &&
        before.size === after.size &&
        before.sha256 === after.sha256
    );
}

async function receive(
    update: MiraComputerUpdate,
    output: FileHandle,
    signal: AbortSignal,
    request: ComputerFetch
) {
    let url = new URL(miraComputerUpdateUrl(update));
    let response: Response | undefined;
    let reader:
        | Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">
        | undefined;
    const cancel = () => {
        void reader?.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        for (let redirects = 0; ; redirects++) {
            signal.throwIfAborted();
            response = await request(url, {
                method: "GET",
                redirect: "manual",
                credentials: "omit",
                cache: "no-store",
                headers: { Accept: "application/octet-stream" },
                signal,
            });
            if (response.redirected) throw new Error("Unexpected update redirect.");
            if (response.status < 300 || response.status >= 400) break;
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || location.length > 8192 || redirects >= 3)
                throw new Error("Unexpected update redirect.");
            url = new URL(location, url);
            if (
                url.protocol !== "https:" ||
                url.username ||
                url.password ||
                url.port ||
                ![
                    "release-assets.githubusercontent.com",
                    "objects.githubusercontent.com",
                ].includes(url.hostname)
            )
                throw new Error("Unexpected update redirect.");
        }
        signal.throwIfAborted();
        if (response.status !== 200 || !response.body)
            throw new Error("The update download is unavailable.");
        const length = response.headers.get("content-length");
        if (
            length !== null &&
            (!/^\d{1,12}$/.test(length) || Number(length) !== update.size)
        )
            throw new Error("The update size does not match the tested release.");
        reader = response.body.getReader();
        signal.throwIfAborted();
        const hash = createHash("sha256");
        let size = 0;
        for (;;) {
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > update.size)
                throw new Error("The update exceeds its tested size.");
            hash.update(next.value);
            await output.writeFile(next.value);
        }
        if (size !== update.size || hash.digest("hex") !== update.sha256)
            throw new Error("The update does not match the tested release.");
        await output.sync();
    } finally {
        signal.removeEventListener("abort", cancel);
        if (reader) {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        } else await response?.body?.cancel().catch(() => {});
    }
}

async function verifyFile(
    input: FileHandle,
    file: string,
    update: MiraComputerUpdate,
    signal: AbortSignal
) {
    // Read the exact file exclusively created for this operation; never reopen a checked pathname.
    const metadata = await input.stat();
    if (!metadata.isFile() || metadata.size !== update.size)
        throw new Error("The staged update changed.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
        signal.throwIfAborted();
        const result = await input.read(buffer, 0, buffer.length, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
        if (size > update.size) throw new Error("The staged update changed.");
        hash.update(buffer.subarray(0, result.bytesRead));
    }
    if (size !== update.size || hash.digest("hex") !== update.sha256)
        throw new Error("The staged update changed.");
    const named = await lstat(file);
    if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.dev !== metadata.dev ||
        named.ino !== metadata.ino ||
        named.size !== update.size
    )
        throw new Error("The staged update changed.");
}

/**
 * Stage one newer Windows installer, authenticate its evidence twice and scope the file to its consumer.
 * @param options - Stable installed version, authenticated private-server lookup, cancellation and optional test transport/temp parent.
 * @param consume - Trusted local consumer invoked only after verification; it must await all file users and never delegate authority from remote data.
 * @returns The consumer's result; the unique staging directory is removed after success, rejection or cancellation.
 */
export async function withComputerUpdate<T>(
    options: {
        installedVersion: string;
        getUpdate: (signal: AbortSignal) => Promise<MiraComputerUpdate | null>;
        signal: AbortSignal;
        request?: ComputerFetch;
        temporaryDirectory?: string;
    },
    consume: (file: string, update: MiraComputerUpdate, signal: AbortSignal) => Promise<T>
): Promise<T> {
    const deadline = new AbortController();
    const signal = AbortSignal.any([options.signal, deadline.signal]);
    let timer = setTimeout(() => deadline.abort(), 300_000);
    let directory: string | undefined;
    let staged: FileHandle | undefined;
    try {
        signal.throwIfAborted();
        const started = performance.now();
        const candidate = await options.getUpdate(signal);
        signal.throwIfAborted();
        if (!candidate) throw new Error("No fresh verified Windows update is available.");
        const update = v.parse(miraComputerUpdateSchema, candidate);
        if (!newerVersion(options.installedVersion, update.version))
            throw new Error("No newer stable Windows update is available.");
        const remaining = Math.floor(update.validForMs - (performance.now() - started));
        if (remaining <= 0) throw new Error("The update evidence expired.");
        clearTimeout(timer);
        timer = setTimeout(() => deadline.abort(), remaining);
        const parent = options.temporaryDirectory ?? tmpdir();
        if (!path.isAbsolute(parent))
            throw new Error("An absolute temporary directory is required.");
        directory = await mkdtemp(path.join(parent, "mira-computer-update-"));
        const file = path.join(directory, "setup.exe");
        staged = await open(file, "wx+", 0o600);
        await receive(update, staged, signal, options.request ?? fetchComputer);
        const confirmationStarted = performance.now();
        const confirmation = v.parse(
            miraComputerUpdateSchema,
            await options.getUpdate(signal)
        );
        await verifyFile(staged, file, update, signal);
        signal.throwIfAborted();
        const validForMs = Math.floor(
            confirmation.validForMs - (performance.now() - confirmationStarted)
        );
        if (!sameRelease(update, confirmation) || validForMs <= 0)
            throw new Error(
                "The authorized update changed or expired. Check again before updating."
            );
        // The consumer owns installation lifetime; the download's deadline must not terminate an installer mid-write.
        clearTimeout(timer);
        return await consume(file, { ...confirmation, validForMs }, options.signal);
    } finally {
        clearTimeout(timer);
        deadline.abort();
        try {
            await staged?.close();
        } finally {
            if (directory) await rm(directory, { recursive: true, force: true });
        }
    }
}
