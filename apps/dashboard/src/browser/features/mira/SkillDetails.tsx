import type { MiraSkillSummary } from "@homelab/contracts/miraSkills";
import {
    ActionGroup,
    Badge,
    buttonStyles,
    ErrorNotice,
    LoadingState,
    Markdown,
    Modal,
    Select,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";

/**
 * Preview one installed guidance file without enabling or executing the package.
 * @returns A bounded shared modal with safe Markdown and pinned source buttons.
 */
export function SkillDetails({
    skill,
    onClose,
}: {
    readonly skill: MiraSkillSummary;
    readonly onClose: () => void;
}) {
    const [file, setFile] = useState("SKILL.md");
    const query = useQuery({
        queryKey: ["operations", "mira", "skill", skill.id, skill.packageHash, file],
        queryFn: () =>
            api.mira.skills.read.query({
                id: skill.id,
                packageHash: skill.packageHash,
                file,
            }),
        retry: false,
    });
    return (
        <Modal
            title={skill.title}
            titleAccessory={<Badge>{skill.version}</Badge>}
            description="Guidance uses the tools and permissions already available to the current run."
            size="wide"
            onClose={onClose}
        >
            <div className="space-y-5">
                {skill.files.length > 1 && (
                    <Select
                        label="Skill file"
                        value={file}
                        onChange={setFile}
                        options={skill.files.map((entry) => ({
                            value: entry.path,
                            label: entry.path,
                        }))}
                    />
                )}
                {query.error && <ErrorNotice error={query.error} />}
                {query.isPending && <LoadingState label="Loading guidance…" />}
                {query.data && <Markdown>{query.data.content}</Markdown>}
                <ActionGroup>
                    {skill.sources.map((url, index) => (
                        <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonStyles({ variant: "secondary" })}
                        >
                            <ExternalLink size={16} aria-hidden="true" />
                            {skill.sources.length === 1
                                ? "View source"
                                : `Source ${index + 1}`}
                        </a>
                    ))}
                </ActionGroup>
            </div>
        </Modal>
    );
}
