import type { MiraComputerSummary } from "@homelab/contracts/miraComputers";
import {
    Badge,
    Button,
    Card,
    ConfirmDialog,
    ErrorNotice,
    LoadingState,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Monitor, Plus, Unplug } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { ComputerPairDialog } from "./ComputerPairDialog";

/**
 * Manage the signed-in operator's paired computers using the existing Settings card design.
 * @returns Bounded inventory, one-use pairing and confirmed versioned revocation.
 */
export function MiraComputers() {
    const [pairing, setPairing] = useState(false);
    const [selected, setSelected] = useState<MiraComputerSummary>();
    const query = useQuery({
        queryKey: ["operations", "mira", "computers"],
        queryFn: ({ signal }) => api.mira.computers.list.query(undefined, { signal }),
        refetchInterval: 15_000,
        retry: false,
    });
    const revoke = useOperation((computer: MiraComputerSummary, signal) =>
        api.mira.computers.revoke.mutate(
            { id: computer.id, version: computer.version },
            { signal }
        )
    );
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Computers"
                icon={Monitor}
                description="Manage the computers connected to your account."
                actions={
                    <Button size="sm" onClick={() => setPairing(true)}>
                        <Plus size={16} aria-hidden="true" />
                        Pair computer
                    </Button>
                }
            />
            {query.isPending && <LoadingState label="Loading computers…" />}
            {query.error && (
                <div className="space-y-3">
                    <ErrorNotice error={query.error} />
                    <Button variant="secondary" onClick={() => void query.refetch()}>
                        Try again
                    </Button>
                </div>
            )}
            {query.data?.length === 0 && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No computers paired yet.
                </p>
            )}
            <div className="max-h-120 space-y-3 overflow-y-auto overscroll-contain">
                {query.data?.map((computer) => {
                    const status = computerStatus(computer, query.dataUpdatedAt);
                    return (
                        <section
                            key={computer.id}
                            className="@container/computer rounded-lg border border-primary-700 bg-primary-950/40 p-4"
                        >
                            <div className="grid gap-3 @min-[32rem]/computer:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/computer:items-center">
                                <SectionHeader
                                    title={computer.label}
                                    icon={Monitor}
                                    badge={<Badge>{status}</Badge>}
                                    description={
                                        computer.platform
                                            ? `${platformLabel(computer.platform)} · ${computer.companionVersion ?? "Unknown version"}`
                                            : "Complete pairing in the companion app."
                                    }
                                />
                                {computer.state !== "revoked" && (
                                    <Button
                                        variant="secondary"
                                        className="w-full @min-[32rem]/computer:w-auto"
                                        onClick={() => setSelected(computer)}
                                    >
                                        <Unplug size={16} aria-hidden="true" />
                                        {computer.state === "pending"
                                            ? "Cancel pairing"
                                            : "Revoke"}
                                    </Button>
                                )}
                            </div>
                        </section>
                    );
                })}
            </div>
            {pairing && <ComputerPairDialog onClose={() => setPairing(false)} />}
            {selected && (
                <ConfirmDialog
                    title={
                        selected.state === "pending"
                            ? "Cancel this pairing?"
                            : "Revoke this computer?"
                    }
                    description={`${selected.label} will no longer be able to connect with this pairing.`}
                    confirmLabel={
                        selected.state === "pending"
                            ? "Cancel pairing"
                            : "Revoke computer"
                    }
                    onClose={() => setSelected(undefined)}
                    onConfirm={async () => {
                        await revoke.mutateAsync(selected);
                        setSelected(undefined);
                    }}
                />
            )}
        </Card>
    );
}

function computerStatus(computer: MiraComputerSummary, checkedAt: number): string {
    if (computer.state === "revoked") return "Revoked";
    if (Date.parse(computer.expiresAt) <= checkedAt) return "Expired";
    if (computer.state === "pending") return "Waiting for pairing";
    return computer.connected ? "Connected" : "Offline";
}
function platformLabel(platform: string): string {
    if (platform === "win32") return "Windows";
    return platform === "darwin" ? "macOS" : "Linux";
}
