import type { MiraSkillSummary } from "@homelab/contracts/miraSkills";
import {
    Badge,
    Button,
    CatalogRow,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    SectionPanel,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronRight } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MiraDisableDialog } from "./MiraDisableDialog";
import { SkillDetails } from "./SkillDetails";

/**
 * Manage release-owned guidance with independent pauses and passive previews.
 * @returns Shared cards showing the installed version and owned skill controls.
 */
export function MiraSkills() {
    const [selected, setSelected] = useState<MiraSkillSummary>();
    const [paused, setPaused] = useState<MiraSkillSummary>();
    const query = useQuery({
        queryKey: ["operations", "mira", "skills"],
        queryFn: () => api.mira.skills.list.query(),
        refetchInterval: 15_000,
    });
    const enable = useOperation((skill: MiraSkillSummary) =>
        api.mira.controls.setEnabled.mutate({
            key: skill.control.key,
            version: skill.control.version,
            enabled: true,
            reason: null,
            until: null,
        })
    );
    const error = query.error ?? enable.error;
    return (
        <SectionPanel
            title="Skills"
            icon={BookOpen}
            description="Installed guidance for Mira. Each skill can be reviewed and paused independently."
        >
            {error && <ErrorNotice error={error} />}
            {query.isPending && <LoadingState label="Loading skills…" />}
            {query.data?.[0]?.compatibility === "offline" && (
                <p className="text-sm text-primary-400">
                    Connect Mira to enable these skills.
                </p>
            )}
            {query.data?.[0]?.compatibility === "update_required" && (
                <p className="text-sm text-primary-400">
                    Update Mira to the same skill catalog before enabling guidance.
                </p>
            )}
            <ul className="divide-y divide-primary-700/70">
                {query.data?.map((skill) => (
                    <CatalogRow
                        key={skill.id}
                        icon={BookOpen}
                        meta={`v${skill.version}`}
                        title={
                            <button
                                type="button"
                                aria-label={`View ${skill.title} skill`}
                                className="inline-flex min-h-8 items-center gap-1.5 rounded text-left hover:text-accent-300 focus-visible:outline-2 focus-visible:outline-accent-300"
                                onClick={() => setSelected(skill)}
                            >
                                {skill.title}
                                <ChevronRight aria-hidden="true" size={14} />
                            </button>
                        }
                        description={skill.description}
                        status={
                            <Badge tone={skill.control.enabled ? "positive" : "neutral"}>
                                {skill.control.enabled ? "Enabled" : "Paused"}
                            </Badge>
                        }
                        actions={
                            (skill.control.enabled ||
                                skill.compatibility === "available") && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    busy={
                                        enable.isPending &&
                                        enable.variables?.id === skill.id
                                    }
                                    onClick={() =>
                                        skill.control.enabled
                                            ? setPaused(skill)
                                            : enable.mutate(skill)
                                    }
                                >
                                    {skill.control.enabled ? "Pause" : "Enable"}
                                </Button>
                            )
                        }
                    >
                        {!skill.control.enabled &&
                            skill.control.version > 1 &&
                            skill.control.reason && (
                                <p>
                                    {skill.control.reason}
                                    {skill.control.until
                                        ? ` · Resumes ${formatDateTime(skill.control.until)}`
                                        : ""}
                                </p>
                            )}
                    </CatalogRow>
                ))}
            </ul>
            {selected && (
                <SkillDetails skill={selected} onClose={() => setSelected(undefined)} />
            )}
            {paused && (
                <MiraDisableDialog
                    control={paused.control}
                    title={paused.title}
                    description="Pauses new loads of this guidance. Previously loaded guidance remains in conversations. Integration access is managed separately."
                    onClose={() => setPaused(undefined)}
                />
            )}
        </SectionPanel>
    );
}
