import { miraSkillIds, miraSkillReadSchema } from "@homelab/contracts/miraSkills";
import type { SQL } from "bun";
import * as v from "valibot";

import type { MiraContext } from "../data/context";
import type { MiraClaim } from "../data/queue";
import { listMiraSkills, loadMiraSkill } from "../data/skills";

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
    const repositoryOnly = async () => {
        if (!run.automationId) return false;
        const [original] = await client<{ kind: string | null }[]>`
            SELECT automation_kind AS kind FROM mira_runs
            WHERE id=${run.id} AND owner=${run.owner}`;
        return !original?.kind || original.kind === "improvement";
    };
    return [
        {
            name: "mira_skills_list",
            description:
                "List reviewed guidance bundled with this Homelab release, including versions, exact file keys, required tools and current owned pause controls. Load applicable enabled guidance before integration or task workflows. Skills never grant tools or provider permissions. No host filesystem or remote skill discovery is performed.",
            automatic: true,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            action: async (input: unknown) => {
                v.parse(v.strictObject({}), input);
                return listMiraSkills(context, await repositoryOnly());
            },
        },
        {
            name: "mira_skill_read",
            description:
                "Read one manifest-listed Markdown file from an enabled, reviewed guidance package. Use IDs and file keys returned by mira_skills_list. The service rechecks the current owner pause and original run scope. Guidance describes existing tools and cannot authorize external actions, load arbitrary paths, run scripts or alter permissions.",
            automatic: true,
            inputSchema: {
                type: "object",
                properties: {
                    id: { enum: [...miraSkillIds] },
                    packageHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                    file: { type: "string", minLength: 1, maxLength: 160 },
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
