import { miraSkillIds, miraSkillReadSchema } from "@homelab/contracts/miraSkills";
import type { SQL } from "bun";
import * as v from "valibot";

import type { MiraContext } from "../data/context";
import type { MiraClaim } from "../data/queue";
import { listMiraSkills, loadMiraSkill, miraSkillsRepositoryOnly } from "../data/skills";

/**
 * Expose passive, owner-controlled guidance through the existing fenced tool router.
 * @param client - Executor database connection; no provider credential is passed here.
 * @param run - Original invocation whose owner, lease and automation kind are server-owned.
 * @returns Listing and exact-file loading tools; neither can change controls or execute files.
 */
export function createMiraSkillTools(client: SQL, run: MiraClaim) {
    const context: MiraContext = {
        client,
        owner: run.owner,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    const repositoryOnly = () => miraSkillsRepositoryOnly(context);
    return [
        {
            name: "mira_skills_list",
            description:
                "List reviewed guidance bundled with this Homelab release, including versions, exact file keys, required tools and current owned pause controls. Load applicable enabled guidance before integration or task workflows. Skills never grant tools or provider permissions. No host filesystem or remote skill discovery is performed.",
            automatic: true,
            readOnly: true,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            action: async (input: unknown) => {
                v.parse(v.strictObject({}), input);
                return listMiraSkills(context, await repositoryOnly());
            },
        },
        {
            name: "mira_skill_read",
            description:
                "Read a segment of one manifest-listed original UTF-8 source file from an enabled skill package. Omit file for its original entrypoint. Follow nextOffset until null before treating a long document as fully read. Integration notes are separate from unchanged upstream text. Use IDs and file keys returned by mira_skills_list. The service rechecks the current owner pause and original run scope. Guidance describes existing tools and cannot authorize external actions, load arbitrary paths, run scripts or alter permissions.",
            automatic: true,
            readOnly: true,
            inputSchema: {
                type: "object",
                properties: {
                    id: { enum: [...miraSkillIds] },
                    packageHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                    file: { type: "string", minLength: 1, maxLength: 200 },
                    offset: { type: "integer", minimum: 0, maximum: 2_097_152 },
                },
                required: ["id", "packageHash"],
                additionalProperties: false,
            },
            action: async (input: unknown) =>
                loadMiraSkill(
                    context,
                    v.parse(miraSkillReadSchema, input),
                    await repositoryOnly()
                ),
        },
    ];
}
