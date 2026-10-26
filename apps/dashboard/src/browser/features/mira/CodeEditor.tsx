import type { MiraCodePublication } from "@homelab/contracts/miraCode";
import {
    ActionGroup,
    Button,
    Card,
    ErrorNotice,
    FormField,
    Input,
    Modal,
    SectionHeader,
    Textarea,
} from "@homelab/ui";
import { CheckCheck } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { CodeCheckPicker } from "./CodeCheckPicker";

/**
 * Prepare PR text around a selected successful edit check without granting external publication.
 * @returns Versioned draft editor using shared fields and responsive actions.
 */
export function CodeEditor({
    draft,
    conversationId,
    onClose,
}: {
    readonly draft?: MiraCodePublication | undefined;
    readonly conversationId?: string | undefined;
    readonly onClose: () => void;
}) {
    const [id] = useState(() => draft?.id ?? crypto.randomUUID());
    const [title, setTitle] = useState(draft?.content.title ?? "");
    const [body, setBody] = useState(draft?.content.body ?? "");
    const [check, setCheck] = useState(
        draft
            ? {
                  id: draft.content.checkId,
                  commit: draft.content.commit,
                  conversationId: draft.conversationId,
                  title: "Selected edit check",
              }
            : undefined
    );
    const [choosing, setChoosing] = useState(false);
    const save = useOperation(() => {
        if (!check) throw new Error("Choose a successful edit check.");
        return api.mira.code.save.mutate({
            id,
            version: draft?.version ?? 0,
            conversationId: check.conversationId,
            content: { title, body, checkId: check.id, commit: check.commit },
        });
    });
    if (choosing)
        return (
            <CodeCheckPicker
                conversationId={conversationId ?? draft?.conversationId ?? undefined}
                onClose={() => setChoosing(false)}
                onSelect={(job, commit) => {
                    setCheck({
                        id: job.id,
                        commit,
                        conversationId: job.conversationId,
                        title: job.content.title,
                    });
                    setChoosing(false);
                }}
            />
        );
    return (
        <Modal
            title={draft ? "Edit code proposal" : "New code proposal"}
            size="wide"
            dismissible={!save.isPending}
            onClose={onClose}
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
                <Card className="bg-primary-900/40">
                    <SectionHeader
                        title={check?.title ?? "Successful edit check"}
                        icon={CheckCheck}
                        description={
                            check
                                ? `Base ${check.commit.slice(0, 12)}`
                                : "Choose the changes tested in Cloud jobs."
                        }
                        actions={
                            <Button
                                variant="secondary"
                                disabled={save.isPending}
                                onClick={() => setChoosing(true)}
                            >
                                {check ? "Change check" : "Choose check"}
                            </Button>
                        }
                    />
                </Card>
                <FormField
                    label="PR title"
                    description="Use a conventional title, for example fix(dashboard): improve the job view."
                >
                    <Input
                        required
                        maxLength={160}
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                </FormField>
                <FormField label="Description">
                    <Textarea
                        required
                        rows={8}
                        maxLength={16_000}
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                    />
                </FormField>
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button type="submit" busy={save.isPending} disabled={!check}>
                        Save proposal
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
