import type { MiraAttachment } from "@homelab/contracts/mira";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

type Draft = { text: string; attachments: MiraAttachment[] };
const empty: Draft = { text: "", attachments: [] };

/** Retain unsent text and selected file references in this dashboard session across chat navigation.
 * @param id - Stable identity of the conversation, including a first message before creation.
 * @returns The local draft and operations for editing or clearing it.
 */
export function useChatDraft(id: string) {
    const client = useQueryClient();
    const key = ["mira-draft", id];
    const [draft, setDraft] = useState(() => client.getQueryData<Draft>(key) ?? empty);
    const update = (changes: Partial<Draft>) => {
        const next = client.setQueryData<Draft>(key, (current) => ({
            ...(current ?? draft),
            ...changes,
        }))!;
        setDraft(next);
    };
    return {
        ...draft,
        setText: (text: string) => update({ text }),
        setAttachments: (attachments: MiraAttachment[]) => update({ attachments }),
        addFile: (file: MiraAttachment) => {
            const files =
                client.getQueryData<Draft>(key)?.attachments ?? draft.attachments;
            if (files.length < 8 && !files.some((entry) => entry.id === file.id))
                update({ attachments: [...files, file] });
        },
        clear: () => {
            client.removeQueries({ queryKey: key, exact: true });
            setDraft(empty);
        },
    };
}
