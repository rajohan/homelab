import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    nativeSkillEngine,
    skillEngineMaxBytes,
} from "@homelab/contracts/miraSkillEngine";

import { verifySkills } from "./verifySkills";

/**
 * Install unchanged native skills and Impeccable's pinned sibling engine in the release.
 * @param command - Packaged native executable in the freshly cleaned build output.
 * @returns Completion after exact original sources and the verified engine are installed; no remote installer runs.
 */
export async function buildNativeSkills(command: string): Promise<void> {
    const packages = await verifySkills();
    for (const entry of packages) {
        const root = path.join(path.dirname(command), "skills", entry.id);
        const engine = nativeSkillEngine(entry, process.platform, process.arch);
        for (const [file, content] of Object.entries(entry.files)) {
            const target = path.join(root, file);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content, {
                encoding: "utf8",
                flag: "wx",
                mode: file === engine?.launcher ? 0o555 : 0o444,
            });
        }
        if (!engine) continue;
        const response = await fetch(engine.url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok || !response.body)
            throw new Error("The pinned native skill engine download failed.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const rawChunk of response.body) {
            const chunk: unknown = rawChunk;
            if (!(chunk instanceof Uint8Array))
                throw new Error("Unexpected engine download bytes.");
            size += chunk.length;
            if (size > skillEngineMaxBytes)
                throw new Error("The native skill engine exceeds its size limit.");
            chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (
            !size ||
            new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== engine.sha256
        )
            throw new Error(
                "The native skill engine differs from its upstream checksum."
            );
        const target = path.join(root, engine.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx", mode: 0o555 });
    }
}
