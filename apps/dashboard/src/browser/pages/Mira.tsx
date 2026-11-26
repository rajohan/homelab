import { IconButton, Modal } from "@homelab/ui";
import { useParams, useSearch } from "@tanstack/react-router";
import { Brain, Files, History, PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

import { ChatConnectionNotice } from "../features/mira/ChatConnectionNotice";
import { ChatConnectionsMenu } from "../features/mira/ChatConnectionsMenu";
import { ChatgptConnection } from "../features/mira/ChatgptConnection";
import { ChatPanel } from "../features/mira/ChatPanel";
import { ChatWelcome } from "../features/mira/ChatWelcome";
import { ConversationList } from "../features/mira/ConversationList";
import { FileLibrary } from "../features/mira/FileLibrary";
import { MemoryLibrary } from "../features/mira/MemoryLibrary";
import { ProposedChanges } from "../features/mira/ProposedChanges";
import { useChatgptConnection } from "../features/mira/useChatgptConnection";

/** Keep chat, its history and the live browser within the dashboard workspace.
 * @returns Responsive chat navigation and the selected conversation.
 */
export function Mira() {
    const [choosingConversation, setChoosingConversation] = useState(false);
    const [rail, setRail] = useState(true);
    const [library, setLibrary] = useState<"files" | "memory" | "connection">();
    const auth = useChatgptConnection();
    if (
        library === "connection" &&
        auth.data?.online &&
        auth.data.state === "connected" &&
        !auth.active
    ) {
        setLibrary(undefined);
    }
    function openSignIn() {
        setLibrary("connection");
        if (auth.canStart && !auth.start.isPending) {
            auth.cancel.reset();
            auth.start.mutate(undefined);
        }
    }
    const connectionControl = <ChatConnectionsMenu auth={auth} onSignIn={openSignIn} />;
    const connectionNotice = <ChatConnectionNotice auth={auth} onSignIn={openSignIn} />;
    const parsed = v.safeParse(
        v.object({ conversationId: v.optional(v.pipe(v.string(), v.uuid())) }),
        useParams({ strict: false })
    );
    const settingsOpen = v.safeParse(
        v.object({ settings: v.literal(true) }),
        useSearch({ strict: false })
    ).success;
    const conversationId = parsed.success ? parsed.output.conversationId : undefined;
    const historyControl = (
        <>
            <IconButton
                icon={History}
                label="Open chat history"
                className="chat-split:hidden"
                onClick={() => setChoosingConversation(true)}
            />
            <IconButton
                icon={PanelLeftOpen}
                label="Show chat history"
                className={rail ? "hidden" : "chat-split:inline-flex hidden"}
                onClick={() => setRail(true)}
            />
        </>
    );
    return (
        <div className="@container/chat-workspace flex min-h-0 flex-1">
            <div className="group/workspace flex min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-panel sm:rounded-xl sm:border sm:border-primary-700">
                {rail && (
                    <aside className="chat-split:flex hidden w-[clamp(14rem,22%,17rem)] shrink-0 border-r border-primary-700 group-has-[[data-browser-pane]]/workspace:hidden">
                        <ConversationList
                            selected={conversationId}
                            landing={!conversationId}
                            onCollapse={() => setRail(false)}
                        />
                    </aside>
                )}
                {conversationId ? (
                    <ChatPanel
                        key={conversationId}
                        id={conversationId}
                        historyControl={historyControl}
                        connectionControl={connectionControl}
                        connectionNotice={connectionNotice}
                        settingsOpen={settingsOpen}
                        onChooseConversation={() => setChoosingConversation(true)}
                        onLibrary={setLibrary}
                    />
                ) : (
                    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <header className="@container/chat-header shrink-0 border-b border-primary-700">
                            <div className="chat-column min-h-chat-header flex items-center gap-2">
                                <div className="flex">{historyControl}</div>
                                <h1 className="min-w-0 flex-1 text-base font-semibold text-primary-50 @min-[34rem]/chat-header:order-first">
                                    New chat
                                </h1>
                                {connectionControl}
                                <IconButton
                                    icon={Brain}
                                    label="Memory"
                                    onClick={() => setLibrary("memory")}
                                />
                                <IconButton
                                    icon={Files}
                                    label="Files"
                                    onClick={() => setLibrary("files")}
                                />
                            </div>
                        </header>
                        {connectionNotice}
                        <div className="chat-welcome-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
                            <ChatWelcome />
                            <ProposedChanges />
                        </div>
                    </section>
                )}
            </div>
            {choosingConversation && (
                <Modal
                    title="Chat history"
                    onClose={() => setChoosingConversation(false)}
                >
                    <ConversationList
                        selected={conversationId}
                        embedded
                        landing={!conversationId}
                        onSelect={() => setChoosingConversation(false)}
                    />
                </Modal>
            )}
            {library === "connection" && (
                <ChatgptConnection
                    auth={auth}
                    onStart={openSignIn}
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
