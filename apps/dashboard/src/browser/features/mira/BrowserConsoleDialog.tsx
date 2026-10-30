import type {
    MiraBrowserAccessSummary,
    miraBrowserHumanCommandSchema,
} from "@homelab/contracts/miraBrowser";
import {
    ActionGroup,
    Badge,
    Button,
    ErrorNotice,
    FormField,
    Input,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Hand, RefreshCw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserPageControls } from "./BrowserPageControls";
import { BrowserUploadControls } from "./BrowserUploadControls";
import { useBrowserCommand } from "./useBrowserCommand";

/**
 * Show passive browser images and explicitly transfer exclusive control to the signed-in operator.
 * @returns A viewport-bounded shared dialog with private input, refresh, return and immediate stop.
 */
export function BrowserConsoleDialog({
    access,
    onClose,
}: {
    readonly access: MiraBrowserAccessSummary;
    readonly onClose: () => void;
}) {
    const queries = useQueryClient();
    const key = ["operations", "mira", "browser-console", access.id];
    const [now, setNow] = useState(Date.now);
    const [url, setUrl] = useState(access.initialUrl ?? "");
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
        queryKey: key,
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
    let label = human ? "You have control" : "Mira has control";
    if (!fresh) label = "Status unavailable";
    return (
        <Modal
            title="Server browser"
            size="wide"
            onClose={onClose}
            titleAccessory={<Badge>{label}</Badge>}
        >
            <div className="space-y-4">
                <div className="@container/browser-console">
                    <div className="grid gap-3 @min-[42rem]/browser-console:grid-cols-[minmax(0,1fr)_auto] @min-[42rem]/browser-console:items-center">
                        <SectionHeader
                            title={human ? "Your turn" : "Browser preview"}
                            icon={human ? Hand : Globe}
                            description={
                                human
                                    ? "Mira waits until you return control. Closing this window keeps Mira paused."
                                    : "Shows Mira’s latest view without interrupting its actions."
                            }
                        />
                        <div className="flex flex-col gap-2 @min-[42rem]/browser-console:flex-row">
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
                                <Square size={14} aria-hidden="true" />
                                Stop access
                            </Button>
                        </div>
                    </div>
                </div>
                {query.error && <ErrorNotice error={query.error} />}
                {(transfer.error || command.error || stop.error) && (
                    <ErrorNotice error={transfer.error ?? command.error ?? stop.error} />
                )}
                <section
                    className="overflow-hidden rounded-lg border border-primary-700 bg-primary-950/40"
                    aria-label="Browser image"
                >
                    {preview ? (
                        <>
                            <div className="border-b border-primary-700 px-4 py-2 text-sm wrap-anywhere text-primary-300">
                                {preview.title || preview.url}
                            </div>
                            <img
                                className="max-h-[55dvh] w-full object-contain"
                                src={`data:image/png;base64,${preview.image}`}
                                width={preview.width}
                                height={preview.height}
                                alt="Latest view of the isolated server browser"
                            />
                        </>
                    ) : (
                        <p className="p-6 text-sm text-primary-400">
                            {human
                                ? "Refresh the view to see the page and its controls."
                                : "The next completed browser observation will appear here."}
                        </p>
                    )}
                </section>
                {query.isPending && <LoadingState />}
                {human && (
                    <section
                        className="space-y-4 rounded-lg border border-primary-700 bg-primary-950/40 p-4"
                        aria-label="Your browser controls"
                    >
                        <ActionGroup>
                            <Button
                                variant="secondary"
                                disabled={Boolean(busy)}
                                onClick={() => send({ method: "observe" })}
                            >
                                <RefreshCw size={14} aria-hidden="true" />
                                Refresh view
                            </Button>
                        </ActionGroup>
                        <FormField
                            label="Website address"
                            description="Use a website included in this browser’s approved access."
                        >
                            <Input
                                value={url}
                                maxLength={2048}
                                onChange={(event) => setUrl(event.target.value)}
                                disabled={Boolean(busy)}
                            />
                        </FormField>
                        <ActionGroup>
                            <Button
                                variant="secondary"
                                disabled={Boolean(busy) || !url}
                                onClick={() => send({ method: "navigate", url })}
                            >
                                Go to address
                            </Button>
                        </ActionGroup>
                        {access.mode === "control" && (
                            <BrowserPageControls
                                preview={preview ?? null}
                                disabled={Boolean(busy) || !inputFresh}
                                onCommand={send}
                            />
                        )}
                        {access.mode === "control" &&
                            (access.origins.length === 1 ? (
                                <BrowserUploadControls
                                    now={now}
                                    accessId={access.id}
                                    preview={preview ?? null}
                                    disabled={Boolean(busy) || !inputFresh}
                                    onCommand={send}
                                />
                            ) : (
                                <p className="text-sm text-primary-400">
                                    To upload an attachment, start browser access for one
                                    website.
                                </p>
                            ))}
                        {preview && !inputFresh && (
                            <p className="text-sm text-primary-400">
                                Refresh the view before the next click or text entry.
                            </p>
                        )}
                    </section>
                )}
            </div>
        </Modal>
    );
}
