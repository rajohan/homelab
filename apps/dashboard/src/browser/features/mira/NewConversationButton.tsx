import { Button, ErrorNotice } from "@homelab/ui";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Create and open a conversation from the sidebar or the empty chat workspace.
 * @returns The shared creation action with pending and error feedback.
 */
export function NewConversationButton({
    onSelect,
    fullWidth = false,
}: {
    readonly onSelect?: (() => void) | undefined;
    readonly fullWidth?: boolean;
}) {
    const navigate = useNavigate();
    const create = useOperation(() =>
        api.mira.conversations.create.mutate({ title: "New conversation" })
    );
    return (
        <>
            <Button
                fullWidth={fullWidth}
                busy={create.isPending}
                onClick={() =>
                    void create
                        .mutateAsync(undefined)
                        .then((chat) =>
                            navigate({
                                to: "/mira/$conversationId",
                                params: { conversationId: chat.id },
                            })
                        )
                        .then(() => onSelect?.())
                        .catch(() => {})
                }
            >
                <Plus size={16} aria-hidden="true" />
                New conversation
            </Button>
            {create.error && <ErrorNotice error={create.error} />}
        </>
    );
}
