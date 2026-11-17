import path from "node:path";

import * as v from "valibot";

import type { NativeSkill } from "./nativeSkills";
import type { SystemSkills } from "./systemSkills";

/**
 * Validate the complete effective skill catalog, including machine-admin discovery roots.
 * @param input - Fresh skills/list response for exactly the isolated workspace.
 * @param codexHome - Canonical private profile containing the verified pinned bundle.
 * @param workspace - Canonical empty workspace used for skill discovery and threads.
 * @param entries - Build-generated fingerprints from the locked native package.
 * @param native - Current run's verified original upstream entrypoints.
 * @throws {Error} Discovery fails, omits expected skills, or exposes any unrelated skill.
 */
export function assertSkillCatalog(
    input: unknown,
    codexHome: string,
    workspace: string,
    entries: SystemSkills,
    native: readonly NativeSkill[] = []
): void {
    const skill = v.object({
        name: v.string(),
        path: v.string(),
        scope: v.picklist(["system", "user"]),
        enabled: v.literal(true),
        pluginId: v.nullish(v.never()),
    });
    const entry = v.object({
        cwd: v.literal(workspace),
        errors: v.pipe(v.array(v.unknown()), v.length(0)),
        skills: v.array(skill),
    });
    const parsed = v.parse(
        v.object({ data: v.pipe(v.array(entry), v.length(1)) }),
        input
    );
    const expected = new Map(
        Object.keys(entries)
            .filter((file) => file.endsWith("/SKILL.md"))
            .map((file) => [
                path.join(codexHome, "skills", ".system", file),
                { name: file.split("/")[0]!, scope: "system" },
            ])
    );
    for (const skill of native)
        expected.set(skill.path, { name: skill.name, scope: "user" });
    const skills = parsed.data[0]!.skills;
    if (skills.length !== expected.size)
        throw new Error("Mira effective skills do not match the reviewed release.");
    for (const skill of skills) {
        if (
            expected.get(skill.path)?.name !== skill.name ||
            expected.get(skill.path)?.scope !== skill.scope
        )
            throw new Error("Mira effective skill catalog contains an unrelated skill.");
        expected.delete(skill.path);
    }
    if (expected.size > 0) throw new Error("Mira effective skill catalog is incomplete.");
}
