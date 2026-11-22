import type { MiraSkillSummary } from "@homelab/contracts/miraSkills";
import {
    ActionGroup,
    Badge,
    Button,
    buttonStyles,
    ErrorNotice,
    LoadingState,
    Modal,
    Select,
    TextFilePreview,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ExternalLink } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";

/**
 * Preview unchanged installed source in bounded segments without enabling or executing it.
 * @returns A shared file preview with separate integration notes, navigation and pinned source links.
 */
export function SkillDetails({
    skill,
    onClose,
}: {
    readonly skill: MiraSkillSummary;
    readonly onClose: () => void;
}) {
    const [file, setFile] = useState(skill.entrypoint);
    const [offsets, setOffsets] = useState([0]);
    const offset = offsets.at(-1)!;
    const query = useQuery({
        queryKey: [
            "operations",
            "mira",
            "skill",
            skill.id,
            skill.packageHash,
            file,
            offset,
        ],
        queryFn: () =>
            api.mira.skills.read.query({
                id: skill.id,
                packageHash: skill.packageHash,
                file,
                offset,
            }),
        retry: false,
    });
    return (
        <Modal
            icon={BookOpen}
            title={skill.title}
            titleAccessory={<Badge>{skill.version}</Badge>}
            description="Skills use the tools and permissions available to the current run."
            size="wide"
            onClose={onClose}
        >
            <div className="space-y-5">
                {skill.integration && (
                    <p className="text-sm text-primary-300">{skill.integration}</p>
                )}
                {skill.files.length > 1 && (
                    <Select
                        label="Skill file"
                        value={file}
                        onChange={(value) => {
                            setFile(value);
                            setOffsets([0]);
                        }}
                        options={skill.files.map((entry) => ({
                            value: entry.path,
                            label: entry.path,
                        }))}
                    />
                )}
                {query.error && <ErrorNotice error={query.error} />}
                {query.isPending && <LoadingState label="Loading skill file…" />}
                {query.data && (
                    <>
                        <TextFilePreview
                            key={file}
                            name={file}
                            mediaType={
                                file.endsWith(".md") ? "text/markdown" : "text/plain"
                            }
                            text={query.data.content}
                        />
                        {(offset > 0 || query.data.nextOffset !== null) && (
                            <ActionGroup>
                                <Button
                                    variant="secondary"
                                    disabled={offsets.length <= 1}
                                    onClick={() =>
                                        setOffsets((values) => values.slice(0, -1))
                                    }
                                >
                                    Previous section
                                </Button>
                                <span className="self-center text-center text-sm text-primary-400">
                                    Characters {offset + 1}–
                                    {offset + query.data.content.length} of{" "}
                                    {query.data.totalCharacters}
                                </span>
                                <Button
                                    variant="primary"
                                    disabled={query.data.nextOffset === null}
                                    onClick={() => {
                                        const next = query.data?.nextOffset;
                                        if (next !== null && next !== undefined)
                                            setOffsets((values) => [...values, next]);
                                    }}
                                >
                                    Next section
                                </Button>
                            </ActionGroup>
                        )}
                    </>
                )}
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
