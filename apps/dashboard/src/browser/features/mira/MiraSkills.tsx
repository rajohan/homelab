import type { MiraSkillSummary } from "@homelab/contracts/miraSkills";
import {
    ActionGroup,
    Badge,
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Eye } from "lucide-react";
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
        <Card className="space-y-4">
            <SectionHeader
                title="Skills"
                icon={BookOpen}
                description="Reusable guidance, reviewed and updated with Homelab. Integration permissions are managed separately."
            />
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
            <div className="max-h-144 space-y-3 overflow-y-auto overscroll-contain">
                {query.data?.map((skill) => (
                    <section
                        key={skill.id}
                        className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4"
                    >
                        <SectionHeader
                            title={skill.title}
                            icon={BookOpen}
                            description={skill.description}
                            badge={
                                <Badge>
                                    {skill.control.enabled ? "Enabled" : "Paused"}
                                </Badge>
                            }
                            actions={
                                <ActionGroup className="w-full min-[30rem]:w-52 min-[30rem]:shrink-0">
                                    <Button
                                        variant="secondary"
                                        onClick={() => setSelected(skill)}
                                    >
                                        <Eye size={16} aria-hidden="true" />
                                        View
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        disabled={
                                            !skill.control.enabled &&
                                            skill.compatibility !== "available"
                                        }
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
                                </ActionGroup>
                            }
                        />
                        <p className="text-sm text-primary-400">
                            Version {skill.version}
                        </p>
                        {!skill.control.enabled &&
                            skill.control.version > 1 &&
                            skill.control.reason && (
                                <p className="text-sm text-primary-300">
                                    {skill.control.reason}
                                </p>
                            )}
                    </section>
                ))}
            </div>
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
        </Card>
    );
}
