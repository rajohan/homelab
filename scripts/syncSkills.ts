import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    skillSourceText,
    validateMiraSkillPackages,
} from "@homelab/contracts/miraSkillPackages";
import { miraSkillFileSchema } from "@homelab/contracts/miraSkills";
import { sourceDependencyConfigSchema } from "@homelab/contracts/sourceDependencies";
import * as v from "valibot";

import { verifyBun } from "./verifyBun";

async function git(directory: string, args: string[]): Promise<Uint8Array> {
    const child = Bun.spawn(["git", "-C", directory, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        timeout: 120_000,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        },
    });
    const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (status !== 0)
        throw new Error(`Skill source fetch failed: ${stderr.slice(0, 2000)}`);
    return stdout;
}

/**
 * Synchronize complete original skill trees at root-manifest pins without running upstream code.
 * @returns Completion after exact UTF-8 bytes, versions and fingerprints are written for review.
 */
export async function main(): Promise<void> {
    await verifyBun();
    if (process.argv.length > 2) throw new Error("Usage: bun run skills:sync");
    const manifestFile = Bun.file(new URL("../package.json", import.meta.url));
    const manifest = (await manifestFile.json()) as {
        config: { skills: Record<string, { contentHash: string }> };
    };
    const config = v.parse(sourceDependencyConfigSchema, manifest.config);
    const bundleFile = Bun.file(
        new URL("../apps/mira/src/server/skills/packages.json", import.meta.url)
    );
    const packages = validateMiraSkillPackages(await bundleFile.json());
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (const [id, source] of Object.entries(config.skills)) {
        const entry = packages.find((item) => item.id === id);
        if (!entry) throw new Error("A configured upstream skill has no package.");
        const temporary = await mkdtemp(path.join(tmpdir(), "homelab-skill-source-"));
        try {
            await git(temporary, ["init", "--quiet"]);
            await git(temporary, [
                "remote",
                "add",
                "origin",
                `https://github.com/${source.update.repository}.git`,
            ]);
            await git(temporary, [
                "fetch",
                "--quiet",
                "--depth=1",
                "origin",
                source.revision,
            ]);
            const actual = decoder
                .decode(await git(temporary, ["rev-parse", "FETCH_HEAD"]))
                .trim();
            if (actual !== source.revision)
                throw new Error("Skill source revision changed.");
            const tree = decoder.decode(
                await git(temporary, [
                    "ls-tree",
                    "-r",
                    "-z",
                    "--full-tree",
                    source.revision,
                ])
            );
            const files: Record<string, string> = {};
            const seen = new Set<string>();
            let bytes = 0;
            for (const item of tree.split("\0").filter(Boolean)) {
                const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(item);
                if (!match) continue;
                const [, mode, kind, object, key] = match;
                const selections = source.include.filter(
                    (root) => key === root || key!.startsWith(root + "/")
                );
                if (selections.length === 0) continue;
                if (kind !== "blob" || (mode !== "100644" && mode !== "100755"))
                    throw new Error("Skill sources must be regular files.");
                v.parse(miraSkillFileSchema, key);
                if (Object.keys(files).length >= 256)
                    throw new Error("Skill source file count exceeds the package limit.");
                const size = Number(
                    decoder
                        .decode(await git(temporary, ["cat-file", "-s", object!]))
                        .trim()
                );
                if (
                    !Number.isSafeInteger(size) ||
                    size < 1 ||
                    size > 2_097_152 ||
                    bytes + size > 8_388_608
                )
                    throw new Error("Skill source file size exceeds the package limit.");
                const original = await git(temporary, ["cat-file", "blob", object!]);
                const content = decoder.decode(original);
                if (
                    original.length !== size ||
                    Buffer.compare(
                        Buffer.from(content, "utf8"),
                        Buffer.from(original)
                    ) !== 0 ||
                    content.includes("\0")
                )
                    throw new Error("Skill source is not lossless UTF-8 text.");
                files[key!] = content;
                bytes += size;
                for (const root of selections) seen.add(root);
            }
            if (
                source.include.some((root) => !seen.has(root)) ||
                !Object.hasOwn(files, source.entrypoint)
            )
                throw new Error("Skill source selection or entrypoint is missing.");
            entry.files = files;
            entry.sources = [
                `https://github.com/${source.update.repository}/tree/${source.revision}`,
            ];
            entry.entrypoint = source.entrypoint;
            entry.version = source.version;
            entry.revision = source.revision;
            manifest.config.skills[id]!.contentHash = new Bun.CryptoHasher("sha256")
                .update(skillSourceText(files))
                .digest("hex");
            console.info(
                `${id}: ${Object.keys(files).length} original files, ${bytes} bytes, ${source.revision}`
            );
        } finally {
            await rm(temporary, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 200,
            });
        }
    }
    const validated = validateMiraSkillPackages(packages);
    await Bun.write(bundleFile, JSON.stringify(validated, null, 4) + "\n");
    await Bun.write(manifestFile, JSON.stringify(manifest, null, 4) + "\n");
}

if (import.meta.main) await main();
