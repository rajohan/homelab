import type { MiraComputerSummary } from "@homelab/contracts/miraComputers";
import {
    Badge,
    buttonStyles,
    Button,
    Card,
    ConfirmDialog,
    ErrorNotice,
    LoadingState,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Download, Monitor, Plus, Unplug } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { ComputerPairDialog } from "./ComputerPairDialog";
import { olderComputerVersion } from "./computerVersions";
import { DesktopComputer } from "./DesktopComputer";

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
    const release = useQuery({
        queryKey: ["operations", "mira", "computer-download"],
        queryFn: ({ signal }) => api.mira.computers.download.query(undefined, { signal }),
        refetchInterval: 60_000,
        retry: false,
    });
    const download =
        !release.isError &&
        release.data?.expiresAt &&
        Date.parse(release.data.expiresAt) >
            Math.max(query.dataUpdatedAt, release.dataUpdatedAt)
            ? release.data.download
            : null;
    const revoke = useOperation((computer: MiraComputerSummary, signal) =>
        api.mira.computers.revoke.mutate(
            { id: computer.id, version: computer.version },
            { signal }
        )
    );
    return (
        <Card className="@container/computers space-y-4">
            <div className="grid gap-3 @min-[48rem]/computers:grid-cols-[minmax(0,1fr)_auto] @min-[48rem]/computers:items-center">
                <SectionHeader
                    title="Computers"
                    icon={Monitor}
                    description="Manage the computers connected to your account."
                />
                <div className="grid gap-2 @min-[48rem]/computers:grid-cols-2">
                    {download && (
                        <a
                            href={download.url}
                            className={buttonStyles({
                                variant: "secondary",
                                size: "sm",
                                fullWidth: true,
                            })}
                            onClick={(event) => {
                                if (
                                    Date.parse(release.data?.expiresAt ?? "") <=
                                    Date.now()
                                ) {
                                    event.preventDefault();
                                    void release.refetch();
                                }
                            }}
                        >
                            <Download size={16} aria-hidden="true" />
                            Download Windows
                        </a>
                    )}
                    <Button size="sm" fullWidth onClick={() => setPairing(true)}>
                        <Plus size={16} aria-hidden="true" />
                        Pair computer
                    </Button>
                </div>
            </div>
            <DesktopComputer />
            <p className="text-sm text-primary-400">
                {download
                    ? `Windows 10 or later · x64 · Version ${download.version}. Install Mira, then pair this computer.`
                    : "Windows download is unavailable until a tested release has been checked."}
            </p>
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
                                    badge={
                                        <div className="flex flex-wrap gap-2">
                                            <Badge>{status}</Badge>
                                            {download &&
                                                computer.state === "paired" &&
                                                Date.parse(computer.expiresAt) >
                                                    query.dataUpdatedAt &&
                                                computer.platform === "win32" &&
                                                olderComputerVersion(
                                                    computer.companionVersion,
                                                    download.version
                                                ) && (
                                                    <Badge tone="warning">
                                                        Update available
                                                    </Badge>
                                                )}
                                        </div>
                                    }
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
