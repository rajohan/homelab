import { IconButton, Modal } from "@homelab/ui";
import { useParams, useSearch } from "@tanstack/react-router";
import { Brain, Files, History, PanelLeftOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import * as v from "valibot";

import { ChatConnectionNotice } from "../features/mira/ChatConnectionNotice";
import { ChatConnectionsMenu } from "../features/mira/ChatConnectionsMenu";
import { ChatgptConnection } from "../features/mira/ChatgptConnection";
import { ChatHeader } from "../features/mira/ChatHeader";
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
    const showHistory = useRef<HTMLButtonElement>(null);
    const hideHistory = useRef<HTMLButtonElement>(null);
    const previousRail = useRef(rail);
    useLayoutEffect(() => {
        if (previousRail.current !== rail) {
            previousRail.current = rail;
            (rail ? hideHistory : showHistory).current?.focus({ preventScroll: true });
        }
    }, [rail]);
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
    const renderHistoryControl = (browserOpen = false) => (
        <>
            <IconButton
                icon={History}
                label="Open chat history"
                aria-haspopup="dialog"
                className={browserOpen ? "" : "chat-split:hidden"}
                onClick={() => setChoosingConversation(true)}
            />
            {!rail && !browserOpen && (
                <IconButton
                    ref={showHistory}
                    icon={PanelLeftOpen}
                    label="Show chat history"
                    aria-expanded={false}
                    className="chat-split:inline-flex hidden"
                    onClick={() => setRail(true)}
                />
            )}
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
                            collapseRef={hideHistory}
                        />
                    </aside>
                )}
                {conversationId ? (
                    <ChatPanel
                        key={conversationId}
                        id={conversationId}
                        renderHistoryControl={renderHistoryControl}
                        connectionControl={connectionControl}
                        connectionNotice={connectionNotice}
                        settingsOpen={settingsOpen}
                        onLibrary={setLibrary}
                    />
                ) : (
                    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <ChatHeader
                            title="New chat"
                            historyControl={renderHistoryControl()}
                        >
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
                        </ChatHeader>
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
