import type {
    MiraBrowserAccessSummary,
    miraBrowserHumanCommandSchema,
} from "@homelab/contracts/miraBrowser";
import { Badge, Button, ErrorNotice, LoadingState, Modal } from "@homelab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { useEffect, useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserDownloadControls } from "./BrowserDownloadControls";
import { BrowserLiveView } from "./BrowserLiveView";
import { BrowserUploadControls } from "./BrowserUploadControls";
import { useBrowserCommand } from "./useBrowserCommand";

/** Open the shared live browser, with exclusive takeover and explicit return to Mira.
 * @returns Chromium's own navigation and page controls inside the authenticated Chat console.
 */
export function BrowserConsoleDialog({
    access,
    onClose,
}: {
    readonly access: MiraBrowserAccessSummary;
    readonly onClose: () => void;
}) {
    const queries = useQueryClient();
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
        (input: { epoch: string; controller: "mira" | "human" }, signal) =>
            api.mira.browser.transfer.mutate({ id: access.id, ...input }, { signal })
    );
    const command = useBrowserCommand();
    const stop = useOperation(
        (id: string, signal) => api.mira.browser.stop.mutate({ id }, { signal }),
        onClose
    );
    const state = query.data;
    const fresh = !query.error && !query.isPending && now - query.dataUpdatedAt < 5000;
    const busy =
        !fresh ||
        state?.busy ||
        transfer.isPending ||
        command.isPending ||
        stop.isPending;
    const human = state?.controller === "human";
    const preview = fresh ? state?.preview : null;
    const inputFresh = preview && now - Date.parse(preview.observedAt) < 55_000;
    const send = (
        operation: v.InferOutput<typeof miraBrowserHumanCommandSchema>["operation"]
    ) => {
        if (!state || !human || busy) return;
        command.mutate({
            id: access.id,
            epoch: state.epoch,
            commandId: crypto.randomUUID(),
            operation,
        });
    };
    const controllerLabel = human ? "You have control" : "Mira has control";
    return (
        <Modal
            title="Browser"
            size="screen"
            onClose={onClose}
            titleAccessory={
                <Badge tone={fresh ? "info" : "warning"}>
                    {fresh ? controllerLabel : "Checking connection"}
                </Badge>
            }
        >
            <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-primary-300">
                        {human
                            ? "Mira is paused. Return control when you finish."
                            : "Watch Mira’s browser as it works."}
                    </p>
                    <div className="flex gap-2">
                        <Button
                            variant="secondary"
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
                            {human ? "Return to Mira" : "Take control"}
                        </Button>
                        <Button
                            variant="secondary"
                            busy={stop.isPending}
                            onClick={() => stop.mutate(access.id)}
                        >
                            <Square size={14} aria-hidden="true" /> Stop browser
                        </Button>
                    </div>
                </div>
                {query.error && <ErrorNotice error={query.error} />}
                {(transfer.error || command.error || stop.error) && (
                    <ErrorNotice error={transfer.error ?? command.error ?? stop.error} />
                )}
                {state && fresh ? (
                    <BrowserLiveView
                        key={access.id}
                        accessId={access.id}
                        epoch={state.epoch}
                        control={human && access.mode === "control"}
                    />
                ) : (
                    <LoadingState />
                )}
                {human && access.mode === "control" && (
                    <details className="border-t border-primary-700 pt-3">
                        <summary className="cursor-pointer text-sm font-medium text-primary-200">
                            Files
                        </summary>
                        <div className="mt-3 space-y-4">
                            <Button
                                variant="secondary"
                                disabled={Boolean(busy)}
                                onClick={() => send({ method: "observe" })}
                            >
                                Choose file controls on this page
                            </Button>
                            <BrowserUploadControls
                                now={now}
                                accessId={access.id}
                                preview={preview ?? null}
                                disabled={Boolean(busy) || !inputFresh}
                                onCommand={send}
                            />
                            <BrowserDownloadControls
                                preview={preview ?? null}
                                disabled={Boolean(busy) || !inputFresh}
                                onCommand={send}
                            />
                        </div>
                    </details>
                )}
            </div>
        </Modal>
    );
}
