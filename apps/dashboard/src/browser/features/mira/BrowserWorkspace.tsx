import type {
    MiraBrowserAccessSummary,
    MiraBrowserFileRequest,
    miraBrowserHumanCommandSchema,
} from "@homelab/contracts/miraBrowser";
import { Button, ErrorNotice, IconButton, LoadingState } from "@homelab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, PanelRightClose } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserFileDialog } from "./BrowserFileDialog";
import { BrowserLiveView, type BrowserViewControls } from "./BrowserLiveView";
import { BrowserMenu } from "./BrowserMenu";
import { BrowserNavigation } from "./BrowserNavigation";
import { useBrowserCommand } from "./useBrowserCommand";

/** Open the shared live browser, with exclusive takeover and explicit return to Mira.
 * @returns The browser's live tabs, navigation and display inside the authenticated chat.
 */
export function BrowserWorkspace({
    access,
    onClose,
}: {
    readonly access: MiraBrowserAccessSummary;
    readonly onClose: () => void;
}) {
    const queries = useQueryClient();
    const pane = useRef<HTMLElement>(null);
    const address = useRef<HTMLInputElement>(null);
    const openingFrom = useRef<string | undefined>(undefined);
    const [viewControls, setViewControls] = useState<BrowserViewControls | null>(null);
    const [fileChoice, setFileChoice] = useState<{
        kind: "upload" | "download";
        epoch: string;
    } | null>(null);
    const [lastClick, setLastClick] = useState<{
        epoch: string;
        request: MiraBrowserFileRequest;
    } | null>(null);
    const [closedRequest, setClosedRequest] = useState<string | null>(null);
    const requestedFullscreen = useRef(false);
    const [fullscreen, setFullscreen] = useState(false);
    useEffect(() => {
        const changed = () => {
            const current =
                requestedFullscreen.current &&
                document.fullscreenElement === document.documentElement;
            requestedFullscreen.current = current;
            setFullscreen(current);
        };
        document.addEventListener("fullscreenchange", changed);
        return () => {
            document.removeEventListener("fullscreenchange", changed);
            if (
                requestedFullscreen.current &&
                document.fullscreenElement === document.documentElement
            )
                void document.exitFullscreen().catch(() => {});
        };
    }, []);
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        const trigger = document.activeElement;
        heading.current?.focus({ preventScroll: true });
        return () => {
            if (trigger instanceof HTMLElement && trigger.isConnected)
                trigger.focus({ preventScroll: true });
        };
    }, []);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    useEffect(
        () => () => {
            queries.removeQueries({
                queryKey: ["operations", "mira", "browser-console", access.id],
            });
        },
        [access.id, queries]
    );
    const query = useQuery({
        queryKey: ["operations", "mira", "browser-console", access.id],
        queryFn: ({ signal }) =>
            api.mira.browser.console.query({ id: access.id }, { signal }),
        refetchInterval: 1000,
        retry: false,
        gcTime: 0,
    });
    const transfer = useOperation(
        async (input: { epoch: string; controller: "mira" | "human" }, signal) => {
            try {
                await api.mira.browser.transfer.mutate(
                    { id: access.id, ...input },
                    { signal }
                );
            } finally {
                // A lost response can still mean that the server transferred control.
                await query.refetch();
            }
        }
    );
    const command = useBrowserCommand();
    const stop = useOperation(async (id: string, signal) => {
        try {
            await api.mira.browser.stop.mutate({ id }, { signal });
        } catch (error) {
            await query.refetch();
            throw error;
        }
    }, onClose);
    const state = query.data;
    const fresh = !query.error && !query.isPending && now - query.dataUpdatedAt < 5000;
    const busy =
        !fresh ||
        state?.busy ||
        transfer.isPending ||
        command.isPending ||
        stop.isPending;
    const human = state?.controller === "human";
    const control =
        fresh &&
        human &&
        access.mode === "control" &&
        !transfer.isPending &&
        !stop.isPending;
    const preview = fresh ? state?.preview : null;
    const send = (
        operation: v.InferOutput<typeof miraBrowserHumanCommandSchema>["operation"]
    ) => {
        if (!state || !human || busy) return;
        const commandId = crypto.randomUUID();
        const accepted = command.mutate({
            id: access.id,
            epoch: state.epoch,
            commandId,
            operation,
        });
        return accepted ? commandId : undefined;
    };
    const tabs = state?.tabs;
    const incoming = control ? state?.fileRequest : null;
    if (
        incoming &&
        state &&
        (incoming.id !== lastClick?.request.id || state.epoch !== lastClick.epoch)
    ) {
        setLastClick({ epoch: state.epoch, request: incoming });
    }
    // Keep a submitted transfer's receipt open after the host consumes its target.
    const fileRequest =
        control &&
        lastClick &&
        lastClick.epoch === state?.epoch &&
        lastClick.request.id !== closedRequest
            ? lastClick.request
            : null;
    const fileKind =
        fileRequest?.kind ??
        (fileChoice?.epoch === state?.epoch ? fileChoice?.kind : undefined);
    const openFiles = (kind: "upload" | "download") => {
        if (!control || !state || busy) return;
        if (fileRequest) setClosedRequest(fileRequest.id);
        setFileChoice({ epoch: state.epoch, kind });
        send({ method: "observe" });
    };
    const toggleFullscreen = () => {
        if (fullscreen) {
            void document.exitFullscreen().catch(() => {});
        } else {
            requestedFullscreen.current = true;
            void document.documentElement.requestFullscreen().catch(() => {
                requestedFullscreen.current = false;
            });
        }
    };
    const navigateWithKeys = (event: KeyboardEvent<HTMLElement>) => {
        if (!tabs || event.defaultPrevented || event.nativeEvent.isComposing) return;
        const key = event.key.toLowerCase();
        const modifier = event.ctrlKey || event.metaKey;
        if (
            (modifier && !event.altKey && key === "l") ||
            (!modifier && event.altKey && key === "d")
        ) {
            event.preventDefault();
            event.stopPropagation();
            address.current?.focus();
            address.current?.select();
            return;
        }
        if (!control || busy) return;
        const tabId = tabs.selectedId;
        const tabAction = (
            input: Extract<
                v.InferOutput<typeof miraBrowserHumanCommandSchema>["operation"],
                { method: "tabs" }
            >["input"]
        ) => {
            event.preventDefault();
            event.stopPropagation();
            send({ method: "tabs", input });
        };
        if (
            modifier &&
            !event.altKey &&
            !event.shiftKey &&
            key === "t" &&
            tabs.items.length < 8
        ) {
            openingFrom.current = tabId;
            tabAction({ action: "open" });
        } else if (
            modifier &&
            !event.altKey &&
            !event.shiftKey &&
            key === "w" &&
            tabs.items.length > 1
        ) {
            tabAction({ action: "close", tabId });
        } else if (modifier && !event.altKey && key === "r") {
            tabAction({ action: "reload", tabId });
        } else if (!modifier && event.altKey && key === "arrowleft" && tabs.canGoBack) {
            tabAction({ action: "back", tabId });
        } else if (
            !modifier &&
            event.altKey &&
            key === "arrowright" &&
            tabs.canGoForward
        ) {
            tabAction({ action: "forward", tabId });
        }
    };
    const ownerLabel = human ? "You have control" : "Mira has control";
    const controllerLabel = fresh ? ownerLabel : "Checking connection";
    const takeover = access.mode === "view" ? "Pause Mira" : "Take control";
    const windowControls = (
        <>
            <Button
                size="sm"
                variant={human ? "secondary" : "primary"}
                className="min-h-8 px-2.5 py-1 text-xs pointer-coarse:min-h-10"
                title={controllerLabel}
                disabled={Boolean(busy)}
                busy={transfer.isPending}
                onClick={() =>
                    state &&
                    transfer.mutate({
                        epoch: state.epoch,
                        controller: human ? "mira" : "human",
                    })
                }
            >
                {human ? "Return to Mira" : takeover}
            </Button>
            <IconButton
                size="sm"
                icon={PanelRightClose}
                label="Close browser view and return to chat"
                className="size-9 min-h-9"
                onClick={onClose}
            />
        </>
    );
    const menu = (
        <BrowserMenu
            view={viewControls}
            control={Boolean(control)}
            busy={Boolean(busy)}
            fullscreen={fullscreen}
            toggleFullscreen={document.fullscreenEnabled ? toggleFullscreen : null}
            files={openFiles}
            stop={() => stop.mutate(access.id)}
        />
    );
    return (
        <aside
            ref={pane}
            data-browser-pane
            aria-label="Browser workspace"
            onKeyDownCapture={navigateWithKeys}
            className={`flex min-h-0 min-w-0 flex-col border-primary-700 bg-surface-panel ${fullscreen ? "fixed inset-0 z-40" : "chat-split:max-w-[65%] chat-split:flex-[1.5] chat-split:border-l flex-1"}`}
        >
            <h2 ref={heading} tabIndex={-1} className="sr-only">
                Browser
            </h2>
            <span className="sr-only">{controllerLabel}</span>
            {state && tabs ? (
                <BrowserNavigation
                    key={state.epoch}
                    tabs={tabs}
                    field={address}
                    onTabShown={(id) => {
                        if (openingFrom.current && openingFrom.current !== id) {
                            openingFrom.current = undefined;
                            requestAnimationFrame(() =>
                                address.current?.focus({ preventScroll: true })
                            );
                        }
                    }}
                    control={control}
                    busy={Boolean(busy)}
                    onCommand={(input) => {
                        openingFrom.current =
                            input.action === "open" ? tabs.selectedId : undefined;
                        send({ method: "tabs", input });
                    }}
                    windowControls={windowControls}
                    menu={menu}
                />
            ) : (
                <header className="flex min-h-12 shrink-0 items-center gap-1.5 border-b border-primary-700 bg-surface-heading px-2">
                    <Globe
                        size={16}
                        aria-hidden="true"
                        className="shrink-0 text-accent-300"
                    />
                    <span className="mr-auto text-sm font-medium">Browser</span>
                    {windowControls}
                    {menu}
                </header>
            )}
            {query.error && <ErrorNotice error={query.error} />}
            {(transfer.error || command.error || stop.error) && (
                <ErrorNotice error={transfer.error ?? command.error ?? stop.error} />
            )}
            {state && fresh ? (
                <BrowserLiveView
                    key={access.id}
                    accessId={access.id}
                    epoch={state.epoch}
                    control={control}
                    onControlsChange={setViewControls}
                />
            ) : (
                !query.error && <LoadingState label="Connecting to browser…" />
            )}
            {state && control && fileKind && (
                <BrowserFileDialog
                    key={fileRequest?.id ?? state.epoch + fileKind}
                    accessId={access.id}
                    epoch={state.epoch}
                    kind={fileKind}
                    request={fileRequest ?? null}
                    preview={preview ?? null}
                    now={now}
                    disabled={Boolean(busy)}
                    onCommand={send}
                    onClose={() => {
                        if (fileRequest) setClosedRequest(fileRequest.id);
                        setFileChoice(null);
                    }}
                />
            )}
        </aside>
    );
}
