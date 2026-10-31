import { Badge, SectionHeader, buttonStyles } from "@homelab/ui";
import { Download, Monitor } from "lucide-react";

import type { api } from "../../api/client";
import { olderComputerVersion } from "../mira/computerVersions";

type Overview = Awaited<ReturnType<typeof api.releases.overview.query>>;

/**
 * Show the operator's installed Windows companions beside verified release downloads.
 * @param props - Authorized release overview, observation time and passive refresh callback.
 * @returns Version and connection status without pairing or remote installation controls.
 */
export function WindowsRelease({
    data,
    checkedAt,
    refresh,
}: {
    readonly data: Overview;
    readonly checkedAt: number;
    readonly refresh: () => void;
}) {
    const release = data.release;
    const expiresAt = release ? Date.parse(release.capturedAt) + 20 * 60_000 : 0;
    const download =
        release?.fresh && release.value.verified && expiresAt > checkedAt
            ? release.value.computer
            : null;
    const computers = data.computers.filter((computer) => computer.platform === "win32");
    return (
        <section className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm">
            <SectionHeader
                title="Windows app"
                icon={Monitor}
                actions={
                    download && (
                        <a
                            href={download.url}
                            className={buttonStyles({ variant: "secondary", size: "sm" })}
                            onClick={(event) => {
                                if (expiresAt <= Date.now()) {
                                    event.preventDefault();
                                    refresh();
                                }
                            }}
                        >
                            <Download size={16} aria-hidden="true" />
                            Download Windows
                        </a>
                    )
                }
            />
            <p className="text-primary-400">
                {download
                    ? `Version ${download.version} · Windows 10 or later · x64`
                    : "Refresh release to check the latest Windows download."}
            </p>
            {computers.length === 0 ? (
                <p className="text-primary-400">No Windows computers paired yet.</p>
            ) : (
                <dl className="max-h-80 space-y-3 overflow-y-auto overscroll-contain">
                    {computers.map((computer) => (
                        <div
                            key={computer.id}
                            className="flex flex-wrap items-center justify-between gap-2 border-t border-primary-700 pt-3"
                        >
                            <dt className="min-w-0 wrap-anywhere">{computer.label}</dt>
                            <dd className="flex flex-wrap items-center gap-2">
                                <span>
                                    {computer.companionVersion ?? "Unknown version"}
                                </span>
                                {!computer.connected && <Badge>Offline</Badge>}
                                {download &&
                                    olderComputerVersion(
                                        computer.companionVersion,
                                        download.version
                                    ) && <Badge tone="warning">Update available</Badge>}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
        </section>
    );
}
