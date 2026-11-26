import { ActivityPanel, Badge, Button, Popover } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, KeyRound, Radio } from "lucide-react";

import { api } from "../../api/client";
import type { ChatgptConnectionState } from "./useChatgptConnection";

/** Show Mira availability and the shared account in the chat header.
 * @returns An anchored connection panel with the available sign-in action.
 */
export function ChatConnectionsMenu({
    auth,
    onSignIn,
}: {
    readonly auth: ChatgptConnectionState;
    readonly onSignIn: () => void;
}) {
    const status = useQuery({
        queryKey: ["operations", "mira", "status"],
        queryFn: ({ signal }) => api.mira.status.query(undefined, { signal }),
        refetchInterval: 15_000,
    });
    const runtime = status.isError ? undefined : status.data;
    let runtimeLabel = status.isError ? "Unavailable" : "Checking";
    if (runtime) {
        runtimeLabel = runtime.online ? "Waiting" : "Offline";
        if (runtime.ready) runtimeLabel = "Ready";
    }
    const runtimeMessage =
        runtime?.message && runtime.message !== auth.data?.message
            ? runtime.message
            : null;
    let providerTone: "positive" | "warning" | "neutral" = auth.showNotice
        ? "warning"
        : "neutral";
    if (auth.data?.state === "connected") providerTone = "positive";
    return (
        <Popover
            label={`Connection status: ${runtimeLabel}`}
            triggerStyle="label"
            layout="feed"
            panelClassName="w-[min(21rem,calc(100vw-1rem))]"
            trigger={
                <>
                    <span
                        aria-hidden="true"
                        className={`size-2 shrink-0 rounded-full ${runtime?.ready ? "bg-emerald-400" : "bg-amber-400"}`}
                    />
                    <span className="hidden @min-[28rem]/chat-header:inline">
                        {runtimeLabel}
                    </span>
                    <ChevronDown size={14} aria-hidden="true" />
                </>
            }
        >
            {({ close }) => (
                <ActivityPanel title="Connections" icon={Radio} onClose={close}>
                    <dl className="divide-y divide-primary-700 rounded-lg border border-primary-700 bg-surface-card px-3">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-3">
                            <dt className="flex items-center gap-2 text-sm font-medium">
                                <Bot
                                    size={17}
                                    aria-hidden="true"
                                    className="text-primary-300"
                                />{" "}
                                Mira
                            </dt>
                            <dd>
                                <Badge tone={runtime?.ready ? "positive" : "neutral"}>
                                    {runtimeLabel}
                                </Badge>
                            </dd>
                            {runtimeMessage && (
                                <dd className="col-span-2 mt-2 text-sm text-primary-300">
                                    {runtimeMessage}
                                </dd>
                            )}
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-3">
                            <dt className="flex items-center gap-2 text-sm font-medium">
                                <KeyRound
                                    size={17}
                                    aria-hidden="true"
                                    className="text-primary-300"
                                />{" "}
                                ChatGPT
                            </dt>
                            <dd>
                                <Badge tone={auth.active ? "info" : providerTone}>
                                    {auth.label}
                                </Badge>
                            </dd>
                            {auth.showNotice && (
                                <dd className="col-span-2 mt-2 text-sm text-primary-300">
                                    {auth.description}
                                </dd>
                            )}
                        </div>
                    </dl>
                    {auth.canOpen && (
                        <Button
                            fullWidth
                            onClick={() => {
                                close();
                                onSignIn();
                            }}
                        >
                            {auth.action}
                        </Button>
                    )}
                </ActivityPanel>
            )}
        </Popover>
    );
}
