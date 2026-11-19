import { Button, Modal, PageHeader } from "@homelab/ui";
import { useParams } from "@tanstack/react-router";
import { Brain, Files } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

import { ChatgptConnection } from "../features/mira/ChatgptConnection";
import { ChatPanel } from "../features/mira/ChatPanel";
import { ChatWelcome } from "../features/mira/ChatWelcome";
import { ConversationList } from "../features/mira/ConversationList";
import { FileLibrary } from "../features/mira/FileLibrary";
import { MemoryLibrary } from "../features/mira/MemoryLibrary";
import { ProposedChanges } from "../features/mira/ProposedChanges";

/**
 * Present persistent Mira chat within the existing Homelab shell and shared design.
 * @returns Conversation navigation and an independently connected chat panel.
 */
export function Mira() {
    const [choosingConversation, setChoosingConversation] = useState(false);
    const [library, setLibrary] = useState<"files" | "memory">();
    const parsed = v.safeParse(
        v.object({ conversationId: v.optional(v.pipe(v.string(), v.uuid())) }),
        useParams({ strict: false })
    );
    const conversationId = parsed.success ? parsed.output.conversationId : undefined;
    return (
        <div
            className={`@container/chat-workspace flex min-h-0 flex-1 flex-col gap-4 ${conversationId ? "" : "overflow-y-auto"}`}
        >
            {!conversationId && (
                <div className="px-3 pt-3 sm:p-0">
                    <PageHeader
                        title="Chat"

                        actions={
                            <>
                                <Button
                                    variant="secondary"
                                    onClick={() => setLibrary("memory")}
                                >
                                    <Brain size={16} aria-hidden="true" />
                                    Memory
                                </Button>
                                <Button
                                    variant="secondary"
                                    onClick={() => setLibrary("files")}
                                >
                                    <Files size={16} aria-hidden="true" />
                                    Files
                                </Button>
                            </>
                        }
                    />
                </div>
            )}
            <div
                className={`chat-split:grid-cols-[clamp(14rem,22%,18rem)_minmax(0,1fr)] grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden bg-primary-950 sm:rounded-xl sm:border sm:border-primary-700 ${conversationId ? "min-h-0" : "min-h-80"}`}
            >
                <div
                    className={`min-h-0 ${conversationId ? "chat-split:flex hidden" : "flex"}`}
                >
                    <ConversationList selected={conversationId} />
                </div>
                {conversationId ? (
                    <ChatPanel
                        key={conversationId}
                        id={conversationId}
                        onChooseConversation={() => setChoosingConversation(true)}
                        onLibrary={setLibrary}
                    />
                ) : (
                    <ChatWelcome />
                )}
            </div>
            {!conversationId && <ChatgptConnection />}
            {!conversationId && <ProposedChanges />}
            {choosingConversation && (
                <Modal
                    title="Choose conversation"
                    onClose={() => setChoosingConversation(false)}
                >
                    <ConversationList
                        selected={conversationId}
                        embedded
                        onSelect={() => setChoosingConversation(false)}
                    />
                </Modal>
            )}
            {library === "files" && <FileLibrary onClose={() => setLibrary(undefined)} />}
            {library === "memory" && (
                <MemoryLibrary onClose={() => setLibrary(undefined)} />
            )}
        </div>
    );
}
