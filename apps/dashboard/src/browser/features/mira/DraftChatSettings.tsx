import type { MiraChatSettings } from "@homelab/contracts/mira";
import { useEffect, useState } from "react";

import { readChatDisplay, saveChatDisplay } from "./chatDisplay";
import { ChatSettings } from "./ChatSettings";
import { useChatModels } from "./useChatModels";
import { MiraVoiceConnection } from "./voiceConnection";

/** Edit preferences locally until the first message creates this conversation.
 * @param props - The reserved conversation identity, its current draft and save/close callbacks.
 * @returns The normal chat settings dialog with draft persistence.
 */
export function DraftChatSettings({
    id,
    settings,
    onSave,
    onClose,
}: {
    readonly id: string;
    readonly settings: MiraChatSettings;
    readonly onSave: (settings: MiraChatSettings) => void;
    readonly onClose: () => void;
}) {
    const catalog = useChatModels();
    const [display, setDisplay] = useState(readChatDisplay);
    const [voice] = useState(() => new MiraVoiceConnection(id, () => {}, true));
    useEffect(() => {
        voice.mount();
        return () => voice.destroy();
    }, [voice]);
    return (
        <ChatSettings
            destination={{ saveDraft: onSave }}
            settings={settings}
            models={catalog.data?.models ?? []}
            defaultModel={catalog.data?.defaultModel ?? null}
            fresh={!catalog.isError && !!catalog.data?.fresh}
            display={display}
            onDisplayChange={(next) => {
                setDisplay(next);
                saveChatDisplay(next);
            }}
            voice={voice}
            onClose={onClose}
        />
    );
}
