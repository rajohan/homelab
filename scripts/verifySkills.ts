import {
    skillSourceText,
    validateMiraSkillPackages,
} from "@homelab/contracts/miraSkillPackages";
import { sourceDependencyConfigSchema } from "@homelab/contracts/sourceDependencies";
import * as v from "valibot";

/**
 * Verify compiled skill source content against the root manifest without contacting upstream.
 * @returns All release-owned packages after verifying the upstream root-manifest pins.
 */
export async function verifySkills() {
    const manifest: unknown = await Bun.file(
        new URL("../package.json", import.meta.url)
    ).json();
    const root = v.parse(v.object({ config: sourceDependencyConfigSchema }), manifest);
    const packages = validateMiraSkillPackages(
        await Bun.file(
            new URL("../apps/mira/src/server/skills/packages.json", import.meta.url)
        ).json()
    );
    for (const [id, source] of Object.entries(root.config.skills)) {
        const entry = packages.find((item) => item.id === id);
        if (
            !entry ||
            entry.version !== source.version ||
            entry.revision !== source.revision ||
            entry.entrypoint !== source.entrypoint ||
            new Bun.CryptoHasher("sha256")
                .update(skillSourceText(entry.files))
                .digest("hex") !== source.contentHash
        )
            throw new Error(
                "Bundled skill sources do not match package.json. Run bun run skills:sync."
            );
    }
    console.info("Verified original skill sources and manifest pins.");
    return packages;
}
