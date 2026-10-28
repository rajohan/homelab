import type { MiraRun } from "@homelab/contracts/mira";
import { Badge, Button, ErrorNotice, SectionHeader } from "@homelab/ui";
import { Monitor, Square } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { computerAccessLabel, useComputerAccess } from "./useComputerAccess";

/**
 * Keep pending/active computer authority and its direct stop visible outside the dialog.
 * @returns A shared responsive header while Mira waits or a request still needs attention.
 */
export function ComputerAccessPanel({
    run,
    waiting,
    onManage,
}: {
    readonly run: MiraRun | null;
    readonly waiting: boolean;
    readonly onManage: () => void;
}) {
    const query = useComputerAccess(run);
    const access = query.data?.[0];
    const stop = useOperation((id: string, signal) =>
        api.mira.computers.access.stop.mutate({ id }, { signal })
    );
    const stoppable = access && !["stopped", "expired"].includes(access.state);
    if (!waiting && !stoppable) return null;
    const fresh = query.fresh;
    return (
        <section
            className="@container/computer-access shrink-0 space-y-3 border-t border-primary-700 px-4 py-3"
            aria-label="Computer access status"
        >
            <div className="grid gap-3 @min-[36rem]/computer-access:grid-cols-[minmax(0,1fr)_auto] @min-[36rem]/computer-access:items-center">
                <SectionHeader
                    title="Computer access"
                    icon={Monitor}
                    badge={<Badge>{computerAccessLabel(access, run, fresh)}</Badge>}
                    {...(waiting && !access
                        ? {
                              description:
                                  "Choose a computer while Mira waits for your permission.",
                          }
                        : {})}
                />
                <div className="flex flex-col gap-2 @min-[36rem]/computer-access:flex-row">
                    <Button variant="secondary" size="sm" onClick={onManage}>
                        Manage access
                    </Button>
                    {stoppable && (
                        <Button
                            variant="secondary"
                            size="sm"
                            busy={stop.isPending}
                            onClick={() => stop.mutate(access.id)}
                        >
                            <Square size={14} aria-hidden="true" />
                            Stop access
                        </Button>
                    )}
                </div>
            </div>
            {stop.error && <ErrorNotice error={stop.error} />}
        </section>
    );
}
