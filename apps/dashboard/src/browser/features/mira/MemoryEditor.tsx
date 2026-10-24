import type { MiraMemory } from "@homelab/contracts/mira";
import {
    ActionGroup,
    Button,
    ErrorNotice,
    FormField,
    Input,
    Modal,
    Textarea,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Edit operator-owned persistent memory independently of message history.
 * @returns A version-checked editor using shared form controls.
 */
export function MemoryEditor({
    memory,
    onClose,
}: {
    readonly memory?: MiraMemory | undefined;
    readonly onClose: () => void;
}) {
    const [title, setTitle] = useState(memory?.title ?? "");
    const [content, setContent] = useState(memory?.content ?? "");
    const save = useOperation(() =>
        memory
            ? api.mira.memory.update.mutate({
                  id: memory.id,
                  version: memory.version,
                  title,
                  content,
              })
            : api.mira.memory.create.mutate({ title, content })
    );
    return (
        <Modal
            title={memory ? "Edit memory" : "New memory"}
            onClose={onClose}
            dismissible={!save.isPending}
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
                <FormField label="What Mira should remember">
                    <Textarea
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        maxLength={32_000}
                    />
                </FormField>
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button type="submit" busy={save.isPending} disabled={!title.trim()}>
                        Save memory
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
