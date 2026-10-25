import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

const fileLimit = 262_144;
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const sandboxPathSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(240),
    v.check((value) =>
        value
            .split("/")
            .every(
                (part) =>
                    /^[A-Za-z0-9_.@()[\]$-]+$/.test(part) &&
                    ![".", "..", ".git"].includes(part.toLowerCase())
            )
    )
);
const editSchema = v.strictObject({
    path: sandboxPathSchema,
    beforeSha256: v.nullable(digest),
    content: v.nullable(v.pipe(v.string(), v.maxLength(fileLimit))),
});
const planSchema = v.strictObject({
    version: v.literal(1),
    commit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    files: v.pipe(v.array(editSchema), v.minLength(1), v.maxLength(20)),
});

function validText(text: string): boolean {
    if (!text.isWellFormed()) return false;
    for (const character of text) {
        const code = character.codePointAt(0)!;
        if (code < 32 && ![9, 10, 13].includes(code)) return false;
    }
    return true;
}
function utf8(bytes: Uint8Array): string {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!validText(text)) throw new Error("Edit plans support text files only.");
    return text;
}
function blob(text: string): string {
    const bytes = Buffer.from(text);
    return new Bun.CryptoHasher("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
}
function lines(text: string): string[] {
    if (!text) return [];
    const parts = text.split("\n");
    if (text.endsWith("\n")) parts.pop();
    return parts;
}
function hunk(text: string, prefix: string): string {
    if (!text) return "";
    return (
        lines(text)
            .map((line) => `${prefix}${line}\n`)
            .join("") + (text.endsWith("\n") ? "" : "\\ No newline at end of file\n")
    );
}
function patch(
    name: string,
    before: string | null,
    after: string | null,
    mode: string
): string {
    const oldLines = lines(before ?? "").length,
        newLines = lines(after ?? "").length;
    let result = `diff --git a/${name} b/${name}\n`;
    if (before === null) result += "new file mode 100644\n";
    if (after === null) result += `deleted file mode ${mode}\n`;
    result += `index ${before === null ? "0".repeat(40) : blob(before)}..${after === null ? "0".repeat(40) : blob(after)}${before !== null && after !== null ? ` ${mode}` : ""}\n`;
    if (oldLines || newLines) {
        result += `--- ${before === null ? "/dev/null" : `a/${name}`}\n`;
        result += `+++ ${after === null ? "/dev/null" : `b/${name}`}\n`;
        result += `@@ -${oldLines ? 1 : 0},${oldLines} +${newLines ? 1 : 0},${newLines} @@\n`;
        result += hunk(before ?? "", "-") + hunk(after ?? "", "+");
    }
    return result;
}

async function original(
    root: string,
    name: string
): Promise<{ text: string; mode: string } | null> {
    const parts = name.split("/");
    let parent = root;
    try {
        for (const part of parts.slice(0, -1)) {
            parent = path.join(parent, part);
            const stat = await lstat(parent);
            if (!stat.isDirectory())
                throw new Error("Edit paths cannot traverse symlinks or special files.");
        }
        const handle = await open(
            path.join(root, name),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > fileLimit)
                throw new Error("Original must be a regular text file up to 256 KiB.");
            const bytes = Buffer.alloc(fileLimit + 1);
            let length = 0;
            while (length < bytes.length) {
                const { bytesRead } = await handle.read(
                    bytes,
                    length,
                    bytes.length - length,
                    null
                );
                if (!bytesRead) break;
                length += bytesRead;
            }
            if (length !== stat.size || length > fileLimit)
                throw new Error("Original file changed while reading.");
            return {
                text: utf8(bytes.subarray(0, length)),
                mode: stat.mode & 0o111 ? "100755" : "100644",
            };
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return null;
        throw error;
    }
}

/**
 * Convert reviewed text replacements into a bounded Git patch without modifying the checkout.
 * @param repository - Canonical fresh checkout; no repository scripts have run yet.
 * @param commit - Exact public base commit already verified by the harness.
 * @param bytes - Digest-verified selected JSON, bounded to one MiB.
 * @param signal - Cancellation checked before reading each selected original.
 * @returns Complete patch for subsequent git apply --check --index and full verification.
 */
export async function buildSandboxEdits(
    repository: string,
    commit: string,
    bytes: Uint8Array,
    signal: AbortSignal
): Promise<string> {
    signal.throwIfAborted();
    if (
        bytes.length === 0 ||
        bytes.length > 1_048_576 ||
        (await realpath(repository)) !== repository
    )
        throw new Error("Invalid edit plan size or checkout directory.");
    const plan = v.parse(planSchema, JSON.parse(utf8(bytes)) as unknown);
    if (plan.commit !== commit)
        throw new Error("Edit plan targets a different base commit.");
    const selected = new Set<string>();
    for (const file of plan.files) {
        if (
            selected.has(file.path) ||
            plan.files.some((other) => other.path.startsWith(`${file.path}/`))
        )
            throw new Error("Edit paths must be unique and cannot overlap.");
        selected.add(file.path);
    }
    let result = "";
    for (const file of plan.files) {
        signal.throwIfAborted();
        const previous = await original(repository, file.path);
        const actual =
            previous === null
                ? null
                : new Bun.CryptoHasher("sha256").update(previous.text).digest("hex");
        if (actual !== file.beforeSha256)
            throw new Error(`Original fingerprint differs for ${file.path}.`);
        if (file.content === null && previous === null)
            throw new Error("Cannot delete a missing file.");
        if (
            file.content !== null &&
            (!validText(file.content) || Buffer.byteLength(file.content) > fileLimit)
        )
            throw new Error("Replacement must be valid UTF-8 text up to 256 KiB.");
        if (file.content === previous?.text)
            throw new Error(`No content change for ${file.path}.`);
        result += patch(
            file.path,
            previous?.text ?? null,
            file.content,
            previous?.mode ?? "100644"
        );
        if (Buffer.byteLength(result) > 1_048_576)
            throw new Error("Generated patch exceeds one MiB; split the change.");
    }
    signal.throwIfAborted();
    return result;
}

/**
 * Read selected source text and fingerprints without following links or running repository code.
 * @param repository - Canonical fresh checkout at the separately verified public commit.
 * @param commit - Exact commit recorded with the source context.
 * @param paths - At most twenty validated relative repository paths; missing files are explicit.
 * @param signal - Cancellation checked before each bounded file read.
 * @returns Bounded JSON artifact with exact text, SHA-256 and mode, marked as untrusted source context.
 */
export async function readSandboxSources(
    repository: string,
    commit: string,
    paths: string[],
    signal: AbortSignal
): Promise<string> {
    const selected = v.parse(v.pipe(v.array(sandboxPathSchema), v.maxLength(20)), paths);
    if ((await realpath(repository)) !== repository || !/^[a-f0-9]{40}$/.test(commit))
        throw new Error("Invalid source checkout or commit.");
    const files = [];
    for (const name of new Set(selected)) {
        signal.throwIfAborted();
        const file = await original(repository, name);
        files.push({
            path: name,
            content: file?.text ?? null,
            mode: file?.mode ?? null,
            sha256: file
                ? new Bun.CryptoHasher("sha256").update(file.text).digest("hex")
                : null,
        });
    }
    signal.throwIfAborted();
    const result =
        JSON.stringify({ commit, files, trust: "untrusted_repository_source" }, null, 2) +
        "\n";
    if (Buffer.byteLength(result) > 1_048_576)
        throw new Error("Selected source context exceeds one MiB; select fewer files.");
    return result;
}
