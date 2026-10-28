import type { MiraRun } from "@homelab/contracts/mira";
import type { miraComputerAccessRequestSchema } from "@homelab/contracts/miraComputers";
import {
    ActionGroup,
    Badge,
    Button,
    ErrorNotice,
    FormField,
    LoadingState,
    Modal,
    SectionHeader,
    Select,
    formatDateTime,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Monitor, Square } from "lucide-react";
import { useState } from "react";
import type * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { computerAccessLabel, useComputerAccess } from "./useComputerAccess";

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
    const [choice, setChoice] = useState("");
    const [mode, setMode] = useState<"view" | "control">("view");
    const computers = useQuery({
        queryKey: ["operations", "mira", "computers"],
        queryFn: ({ signal }) => api.mira.computers.list.query(undefined, { signal }),
        refetchInterval: 5000,
        retry: false,
    });
    const accessQuery = useComputerAccess(run?.id);
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
    const connected = (computers.data ?? []).filter(
        (pc) => pc.state === "paired" && pc.connected && Date.parse(pc.expiresAt) > now
    );
    const selected = connected.find((pc) => `${pc.id}:${pc.version}` === choice);
    const ready =
        running &&
        supportsImages &&
        fresh &&
        !current &&
        !computers.error &&
        now - computers.dataUpdatedAt < 10_000 &&
        Boolean(selected);
    return (
        <Modal
            title="Computer access"
            description="Share one window with Mira for this run. Choose and approve the window on your computer."
            onClose={onClose}
            dismissible={!request.isPending}
        >
            <div className="space-y-4">
                {access && (
                    <section className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                        <SectionHeader
                            title={
                                computers.data?.find((pc) => pc.id === access.computerId)
                                    ?.label ?? "Selected computer"
                            }
                            icon={Monitor}
                            badge={
                                <Badge>{computerAccessLabel(access, run, fresh)}</Badge>
                            }
                            description={`Ends by ${formatDateTime(access.expiresAt)}`}
                        />
                        {access.state === "pending" && fresh && running && (
                            <p className="text-sm text-primary-300">
                                Select a window and choose Allow in the companion on your
                                PC. This request expires after one minute.
                            </p>
                        )}
                        {stoppable && (
                            <Button
                                variant="secondary"
                                fullWidth
                                busy={stop.isPending}
                                onClick={() => stop.mutate(access.id)}
                            >
                                <Square size={16} aria-hidden="true" />
                                Stop access
                            </Button>
                        )}
                    </section>
                )}
                {!running && (
                    <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-300">
                        Ask Mira to help with your computer first. Access can be requested
                        while that manual run is running, and ends when the run stops.
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
                    <form
                        className="space-y-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (ready && selected && run)
                                request.mutate({
                                    computerId: selected.id,
                                    computerVersion: selected.version,
                                    runId: run.id,
                                    mode,
                                });
                        }}
                    >
                        <FormField label="Computer">
                            <Select
                                label="Computer"
                                value={selected ? choice : ""}
                                disabled={
                                    request.isPending ||
                                    computers.isPending ||
                                    Boolean(computers.error)
                                }
                                options={[
                                    { value: "", label: "Choose a connected computer" },
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
                        <FormField label="Permission">
                            <Select
                                label="Computer permission"
                                value={mode}
                                disabled={request.isPending}
                                options={[
                                    { value: "view", label: "View only" },
                                    {
                                        value: "control",
                                        label: "Control — view, click and type",
                                    },
                                ]}
                                onChange={setMode}
                            />
                            <p className="text-xs text-primary-400">
                                Up to five minutes for this run. Local approval is
                                required. You can stop access here or on your PC at any
                                time.
                            </p>
                        </FormField>
                        <ActionGroup>
                            <Button
                                type="submit"
                                busy={request.isPending}
                                disabled={!ready}
                            >
                                Request access
                            </Button>
                            <Button
                                variant="secondary"
                                disabled={request.isPending}
                                onClick={onClose}
                            >
                                Close
                            </Button>
                        </ActionGroup>
                    </form>
                )}
                {request.error && <ErrorNotice error={request.error} />}
                {stop.error && <ErrorNotice error={stop.error} />}
                {(!running || current) && (
                    <Button
                        variant="secondary"
                        fullWidth
                        disabled={request.isPending}
                        onClick={onClose}
                    >
                        Close
                    </Button>
                )}
            </div>
        </Modal>
    );
}
