import { Button, Modal, PageHeader } from "@homelab/ui";
import { useParams } from "@tanstack/react-router";
import { Brain, Files, Mail } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

import { ChatPanel } from "../features/mira/ChatPanel";
import { ChatWelcome } from "../features/mira/ChatWelcome";
import { ConversationList } from "../features/mira/ConversationList";
import { FileLibrary } from "../features/mira/FileLibrary";
import { MailLibrary } from "../features/mira/MailLibrary";
import { MemoryLibrary } from "../features/mira/MemoryLibrary";

/**
 * Present persistent Mira chat within the existing Homelab shell and shared design.
 * @returns Conversation navigation and an independently connected chat panel.
 */
export function Mira() {
    const [choosingConversation, setChoosingConversation] = useState(false);
    const [library, setLibrary] = useState<"files" | "memory" | "mail">();
    const parsed = v.safeParse(
        v.object({ conversationId: v.optional(v.pipe(v.string(), v.uuid())) }),
        useParams({ strict: false })
    );
    const conversationId = parsed.success ? parsed.output.conversationId : undefined;
    return (
        <div
            className={`flex min-h-0 flex-1 flex-col gap-4 ${conversationId ? "" : "overflow-y-auto"}`}
        >
            {!conversationId && (
                <PageHeader
                    title="Chat"
                    description="Chat, plan work and keep your tasks and context together."
                    actions={
                        <>
                            <Button
                                variant="secondary"
                                onClick={() => setLibrary("mail")}
                            >
                                <Mail size={16} aria-hidden="true" />
                                Email drafts
                            </Button>
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
            )}
            <div
                className={`grid min-w-0 flex-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] ${conversationId ? "min-h-0" : "min-h-96"}`}
            >
                <div className={`min-h-0 ${conversationId ? "hidden lg:flex" : "flex"}`}>
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
            {library === "mail" && (
                <MailLibrary
                    conversationId={conversationId}
                    onClose={() => setLibrary(undefined)}
                />
            )}
            {library === "files" && <FileLibrary onClose={() => setLibrary(undefined)} />}
            {library === "memory" && (
                <MemoryLibrary onClose={() => setLibrary(undefined)} />
            )}
        </div>
    );
}
