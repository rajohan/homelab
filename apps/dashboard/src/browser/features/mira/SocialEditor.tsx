import type { MiraSocialDraft } from "@homelab/contracts/miraSocial";
import {
    ActionGroup,
    Button,
    ErrorNotice,
    FormField,
    Input,
    Modal,
    Select,
    Textarea,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Compose an unsent Moltbook post or reply using the shared responsive form controls.
 * @returns A bounded local editor; saving never authorizes public submission.
 */
export function SocialEditor({
    draft,
    conversationId,
    onClose,
}: {
    readonly draft?: MiraSocialDraft | undefined;
    readonly conversationId?: string | undefined;
    readonly onClose: () => void;
}) {
    const [id] = useState(() => draft?.id ?? crypto.randomUUID());
    const [kind, setKind] = useState<"post" | "comment">(draft?.content.kind ?? "post");
    const [community, setCommunity] = useState(
        draft?.content.kind === "post" ? draft.content.community : ""
    );
    const [title, setTitle] = useState(
        draft?.content.kind === "post" ? draft.content.title : ""
    );
    const [postId, setPostId] = useState(
        draft?.content.kind === "comment" ? draft.content.postId : ""
    );
    const [parentId, setParentId] = useState(
        draft?.content.kind === "comment" ? (draft.content.parentId ?? "") : ""
    );
    const [text, setText] = useState(draft?.content.text ?? "");
    const save = useOperation(() =>
        api.mira.social.save.mutate({
            id,
            version: draft?.version ?? 0,
            conversationId: draft?.conversationId ?? conversationId ?? null,
            content:
                kind === "post"
                    ? { kind, community, title, text }
                    : { kind, postId, parentId: parentId || null, text },
        })
    );
    return (
        <Modal
            title={draft ? "Edit Moltbook draft" : "New Moltbook draft"}
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
                <FormField label="Type">
                    <Select
                        value={kind}
                        options={[
                            { value: "post", label: "Post" },
                            { value: "comment", label: "Comment or reply" },
                        ]}
                        onChange={(value) =>
                            setKind(value === "comment" ? "comment" : "post")
                        }
                    />
                </FormField>
                {kind === "post" ? (
                    <>
                        <FormField
                            label="Community"
                            description="Moltbook community name, without a URL."
                        >
                            <Input
                                value={community}
                                onChange={(event) => setCommunity(event.target.value)}
                                required
                                maxLength={30}
                                pattern="[a-z0-9_]{2,30}"
                            />
                        </FormField>
                        <FormField label="Title">
                            <Input
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                required
                                maxLength={300}
                            />
                        </FormField>
                    </>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label="Post ID">
                            <Input
                                value={postId}
                                onChange={(event) => setPostId(event.target.value)}
                                required
                                maxLength={128}
                            />
                        </FormField>
                        <FormField
                            label="Parent comment ID"
                            description="Leave empty to comment directly on the post."
                        >
                            <Input
                                value={parentId}
                                onChange={(event) => setParentId(event.target.value)}
                                maxLength={128}
                            />
                        </FormField>
                    </div>
                )}
                <FormField label="Text">
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        required
                        rows={10}
                        maxLength={kind === "post" ? 40_000 : 10_000}
                    />
                </FormField>
                <p className="text-sm text-primary-400">
                    Save this draft, then review the exact text and destination before
                    sending it publicly.
                </p>
                {save.error && <ErrorNotice error={save.error} />}
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
