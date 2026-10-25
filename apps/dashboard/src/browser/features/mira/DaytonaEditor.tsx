import type { MiraDaytonaContent, MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
import {
    ActionGroup,
    Button,
    ErrorNotice,
    FormField,
    Input,
    Modal,
    Textarea,
} from "@homelab/ui";
import { FilePlus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { FileLibrary } from "./FileLibrary";

/**
 * Compose a cloud proposal without running it.
 * @returns Shared editor with explicit file selection and sandbox paths.
 */
export function DaytonaEditor({
    job,
    conversationId,
    onClose,
}: {
    readonly job?: MiraDaytonaJob | undefined;
    readonly conversationId?: string | undefined;
    readonly onClose: () => void;
}) {
    const [id] = useState(() => job?.id ?? crypto.randomUUID());
    const [title, setTitle] = useState(job?.content.title ?? "");
    const [command, setCommand] = useState(job?.content.command ?? "");
    const [inputs, setInputs] = useState<MiraDaytonaContent["inputs"]>(
        job?.content.inputs ?? []
    );
    const [outputs, setOutputs] = useState(job?.content.outputs.join("\n") ?? "");
    const [picking, setPicking] = useState(false);
    const select = useOperation(async (fileId: string) => {
        const file = await api.mira.daytona.input.query({ id: fileId });
        setInputs((previous) =>
            previous.some((value) => value.id === file.id)
                ? previous
                : [
                      ...previous,
                      {
                          ...file,
                          name: /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(file.name)
                              ? file.name
                              : `input-${previous.length + 1}.txt`,
                      },
                  ]
        );
        setPicking(false);
    });
    const save = useOperation(() =>
        api.mira.daytona.save.mutate({
            id,
            version: job?.version ?? 0,
            conversationId: job?.conversationId ?? conversationId ?? null,
            taskId: job?.taskId ?? null,
            content: {
                title,
                command,
                inputs,
                outputs: outputs
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
            },
        })
    );
    if (picking)
        return (
            <FileLibrary
                onClose={() => setPicking(false)}
                onSelect={(file) => {
                    void select.mutateAsync(file.id).catch(() => setPicking(false));
                }}
            />
        );
    return (
        <Modal
            title={job ? "Edit cloud job" : "New cloud job"}
            onClose={onClose}
            dismissible={!save.isPending}
            size="wide"
        >
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save
                        .mutateAsync(undefined)
                        .then(onClose)
                        .catch(() => {});
                }}
            >
                <FormField label="Title">
                    <Input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        required
                        maxLength={160}
                    />
                </FormField>
                <FormField
                    label="Command"
                    description="Runs in a fresh private Daytona sandbox. Review the command before starting; do not include credentials."
                >
                    <Textarea
                        value={command}
                        onChange={(event) => setCommand(event.target.value)}
                        rows={8}
                        required
                        maxLength={16_384}
                        className="font-mono"
                    />
                </FormField>
                <div className="space-y-3">
                    <p className="text-sm text-primary-300">
                        Input files are copied to{" "}
                        <code className="wrap-anywhere">
                            /tmp/homelab-mira/{id}/inputs/
                        </code>
                        . Write selected results under the matching <code>outputs/</code>{" "}
                        directory.
                    </p>
                    {inputs.map((file, index) => (
                        <div key={file.id} className="flex items-end gap-2">
                            <FormField label={`Input ${index + 1} filename`}>
                                <Input
                                    value={file.name}
                                    onChange={(event) =>
                                        setInputs((previous) =>
                                            previous.map((value) =>
                                                value.id === file.id
                                                    ? {
                                                          ...value,
                                                          name: event.target.value,
                                                      }
                                                    : value
                                            )
                                        )
                                    }
                                    required
                                    maxLength={160}
                                    pattern="[A-Za-z0-9_-][A-Za-z0-9_.-]*"
                                />
                            </FormField>
                            <Button
                                variant="secondary"
                                aria-label={`Remove ${file.name}`}
                                onClick={() =>
                                    setInputs((previous) =>
                                        previous.filter((value) => value.id !== file.id)
                                    )
                                }
                            >
                                <Trash2 size={16} />
                            </Button>
                        </div>
                    ))}
                    <Button
                        variant="secondary"
                        disabled={inputs.length >= 4}
                        onClick={() => setPicking(true)}
                    >
                        <FilePlus size={16} />
                        Select input file
                    </Button>
                </div>
                <FormField
                    label="Result filenames"
                    description="One filename per line, up to four. Each input or result must be at most 1 MiB. Results support text, PDF and images."
                >
                    <Textarea
                        value={outputs}
                        onChange={(event) => setOutputs(event.target.value)}
                        rows={4}
                        maxLength={643}
                    />
                </FormField>
                {(save.error || select.error) && (
                    <ErrorNotice error={save.error ?? select.error} />
                )}
                <ActionGroup>
                    <Button type="submit" busy={save.isPending}>
                        Save draft
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={save.isPending}
                        onClick={onClose}
                    >
                        Cancel
                    </Button>
                </ActionGroup>
            </form>
        </Modal>
    );
}
