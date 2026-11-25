import type { MiraRun } from "@homelab/contracts/mira";
import type {
    miraComputerAccessRequestSchema,
    MiraComputerAccessSummary,
} from "@homelab/contracts/miraComputers";
import {
    ActionGroup,
    Badge,
    Button,
    ChoiceBar,
    ErrorNotice,
    formatDateTime,
    FormField,
    LoadingState,
    Modal,
    SectionHeader,
    Select,
} from "@homelab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Monitor, Square } from "lucide-react";
import { useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { hasDesktopBridge, requestDesktop } from "./desktopClient";
import { accessStatusTone } from "./statusTone";
import {
    computerAccessLabel,
    computerScopeLabel,
    useComputerAccess,
} from "./useComputerAccess";

/**
 * Let the operator choose a connected PC and scope for this exact live manual run.
 * @returns A viewport-bounded shared form, effective status and an immediate stop control.
 */
export function ComputerAccessDialog({
    run,
    supportsImages,
    onClose,
}: {
    readonly run: MiraRun | null;
    readonly supportsImages: boolean;
    readonly onClose: () => void;
}) {
    const [choice, setChoice] = useState<string | null>(null);
    const [mode, setMode] = useState<"view" | "control">("view");
    const desktop = hasDesktopBridge();
    const cache = useQueryClient();
    const local = useQuery({
        queryKey: ["mira", "desktop"],
        queryFn: ({ signal }) => requestDesktop({ action: "state" }, signal),
        enabled: desktop,
        retry: false,
    });
    const computers = useQuery({
        queryKey: ["operations", "mira", "computers"],
        queryFn: ({ signal }) => api.mira.computers.list.query(undefined, { signal }),
        refetchInterval: 5000,
        retry: false,
    });
    const accessQuery = useComputerAccess(run);
    const access = accessQuery.data?.[0];
    const request = useOperation(
        (input: v.InferOutput<typeof miraComputerAccessRequestSchema>, signal) =>
            api.mira.computers.access.request.mutate(input, { signal })
    );
    const stop = useOperation((id: string, signal) =>
        api.mira.computers.access.stop.mutate({ id }, { signal })
    );
    const running = run?.state === "running" && !run.cancelRequested && !run.automationId;
    const { fresh, now } = accessQuery;
    const current = access && ["pending", "active"].includes(access.state);
    const stoppable = access && !["stopped", "expired"].includes(access.state);
    const status = computerAccessLabel(access, run, fresh);
    const pcName = computers.data?.find((pc) => pc.id === access?.computerId)?.label;
    const scopeLabel = computerScopeLabel(access?.scope);
    const connected = (computers.data ?? []).filter(
        (pc) => pc.state === "paired" && pc.connected && Date.parse(pc.expiresAt) > now
    );
    const onlyComputer = connected.length === 1 ? connected[0] : undefined;
    const preferred = desktop
        ? connected.find((pc) => pc.id === local.data?.computerId)
        : onlyComputer;
    // Keep the displayed target fixed if another PC connects while the dialog is open.
    if (choice === null && preferred) setChoice(`${preferred.id}:${preferred.version}`);
    const selected = connected.find((pc) => `${pc.id}:${pc.version}` === choice);
    const ready =
        running &&
        !request.isPending &&
        supportsImages &&
        fresh &&
        !current &&
        !computers.error &&
        now - computers.dataUpdatedAt < 10_000 &&
        Boolean(selected);
    function share(scope: "window" | "displays") {
        if (!ready || !selected || !run) return;
        request.mutate(
            {
                computerId: selected.id,
                computerVersion: selected.version,
                runId: run.id,
                mode,
                scope,
                keepOpen: true,
            },
            {
                onSuccess: (accepted) => {
                    cache.setQueryData<MiraComputerAccessSummary[]>(
                        accessQuery.queryKey,
                        (prior = []) =>
                            prior.some((item) => item.id === accepted.id)
                                ? prior
                                : [accepted, ...prior]
                    );
                },
            }
        );
    }
    return (
        <Modal
            title="Computer access"
            description="Share a Windows PC with Mira in this chat."
            onClose={onClose}
            dismissible={!request.isPending}
        >
            <div className="space-y-4">
                {access && !stoppable && (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-primary-400">
                        <span>
                            Last session · {pcName ?? "Computer"} · {scopeLabel}
                        </span>
                        <Badge tone={accessStatusTone(status)}>{status}</Badge>
                    </div>
                )}
                {stoppable && (
                    <section className="space-y-3 rounded-lg border border-primary-700 bg-surface-card p-4">
                        <SectionHeader
                            title={pcName ?? "Selected computer"}
                            icon={Monitor}
                            badge={
                                <Badge tone={accessStatusTone(status)}>{status}</Badge>
                            }
                            description={[
                                scopeLabel,
                                access.state === "pending" &&
                                    (access.mode === "view"
                                        ? "View only"
                                        : "View and control"),
                                access.keepOpen
                                    ? "This chat"
                                    : `Ends by ${formatDateTime(access.expiresAt)}`,
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        />
                        {access.state === "pending" && fresh && running && (
                            <p className="text-sm text-primary-300">
                                {access.scope === "desktop" || access.scope === "displays"
                                    ? "Review desktop access"
                                    : "Select a window"}{" "}
                                and choose Allow in the companion on your PC. This request
                                expires after one minute.
                            </p>
                        )}
                        <Button
                            variant="danger"
                            fullWidth
                            busy={stop.isPending}
                            onClick={() => stop.mutate(access.id)}
                        >
                            <Square size={16} aria-hidden="true" />
                            Stop access
                        </Button>
                    </section>
                )}
                {!running && !current && (
                    <p className="rounded-lg border border-primary-700 bg-surface-card p-4 text-sm text-primary-300">
                        Ask Mira to help with your computer first. Access can be requested
                        while that manual run is running. Existing conversation access
                        stays open between replies.
                    </p>
                )}
                {(computers.isPending || (run && accessQuery.isPending)) && (
                    <LoadingState label="Loading computer access…" />
                )}
                {computers.error && <ErrorNotice error={computers.error} />}
                {accessQuery.error && <ErrorNotice error={accessQuery.error} />}
                {(computers.error || accessQuery.error) && (
                    <Button
                        variant="secondary"
                        fullWidth
                        onClick={() => {
                            void computers.refetch();
                            void accessQuery.refetch();
                        }}
                    >
                        Refresh status
                    </Button>
                )}
                {running && !supportsImages && (
                    <p className="text-sm text-primary-300">
                        Computer tools need a model with image support. Choose one in Chat
                        settings before starting a computer-assisted run.
                    </p>
                )}
                {running && !current && (
                    <fieldset className="min-w-0 space-y-4" disabled={request.isPending}>
                        {connected.length === 1 && selected ? (
                            <SectionHeader
                                title={selected.label}
                                icon={Monitor}
                                description="Connected computer"
                            />
                        ) : (
                            <FormField label="Computer">
                                <Select
                                    label="Computer"
                                    value={
                                        selected
                                            ? `${selected.id}:${selected.version}`
                                            : ""
                                    }
                                    disabled={
                                        request.isPending ||
                                        computers.isPending ||
                                        Boolean(computers.error)
                                    }
                                    options={[
                                        {
                                            value: "",
                                            label: "Choose a connected computer",
                                        },
                                        ...connected.map((pc) => ({
                                            value: `${pc.id}:${pc.version}`,
                                            label: pc.label,
                                        })),
                                    ]}
                                    onChange={setChoice}
                                />
                                {!computers.isPending &&
                                    !computers.error &&
                                    connected.length === 0 && (
                                        <p className="text-sm text-primary-400">
                                            No computers are connected. Pair your PC in
                                            Settings → Computers and start its companion.
                                        </p>
                                    )}
                            </FormField>
                        )}
                        <div className="space-y-1.5">
                            <ChoiceBar
                                label="Computer permission"
                                value={mode}
                                options={[
                                    { value: "view", label: "View only" },
                                    { value: "control", label: "View and control" },
                                ]}
                                onChange={setMode}
                            />
                            <p className="text-sm text-primary-400">
                                {mode === "view"
                                    ? "Mira can see what you share."
                                    : "Mira can see, click and type in what you share."}
                            </p>
                        </div>
                        <p className="text-sm text-primary-300">
                            Sharing all displays includes visible apps and notifications.
                            Choose a window to share just that window.
                        </p>
                        <p className="text-sm text-primary-400">
                            Approve once on your PC for this chat. Stop sharing here or on
                            the PC at any time. Locking or disconnecting ends access.
                        </p>
                        <ActionGroup>
                            <Button
                                variant="secondary"
                                busy={
                                    request.isPending &&
                                    request.variables.scope === "window"
                                }
                                disabled={!ready}
                                onClick={() => share("window")}
                            >
                                <AppWindow size={16} aria-hidden="true" />
                                Choose a window
                            </Button>
                            <Button
                                busy={
                                    request.isPending &&
                                    request.variables.scope === "displays"
                                }
                                disabled={!ready}
                                onClick={() => share("displays")}
                            >
                                <Monitor size={16} aria-hidden="true" />
                                Share all displays
                            </Button>
                        </ActionGroup>
                    </fieldset>
                )}
                {request.error && <ErrorNotice error={request.error} />}
                {stop.error && <ErrorNotice error={stop.error} />}
            </div>
        </Modal>
    );
}
