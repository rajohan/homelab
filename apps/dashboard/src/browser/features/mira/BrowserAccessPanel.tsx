import type { MiraRun } from "@homelab/contracts/mira";
import { Badge, Button, ErrorNotice, SectionHeader } from "@homelab/ui";
import { Globe, Square } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { browserAccessLabel, useBrowserAccess } from "./useBrowserAccess";

/**
 * Keep pending/active browser authority and its direct stop visible outside the dialog.
 * @returns A shared responsive header while Mira waits or a request still needs attention.
 */
export function BrowserAccessPanel({
    run,
    waiting,
    onManage,
}: {
    readonly run: MiraRun | null;
    readonly waiting: boolean;
    readonly onManage: () => void;
}) {
    const query = useBrowserAccess(run);
    const access = query.data?.[0];
    const stop = useOperation((id: string, signal) =>
        api.mira.browser.stop.mutate({ id }, { signal })
    );
    const stoppable = access && !["closed"].includes(access.state);
    if (!waiting && !stoppable) return null;
    const fresh = query.fresh;
    return (
        <section
            className="@container/browser-access shrink-0 space-y-3 border-t border-primary-700 px-4 py-3"
            aria-label="Browser access status"
        >
            <div className="grid gap-3 @min-[36rem]/browser-access:grid-cols-[minmax(0,1fr)_auto] @min-[36rem]/browser-access:items-center">
                <SectionHeader
                    title="Browser access"
                    icon={Globe}
                    badge={<Badge>{browserAccessLabel(access, run, fresh)}</Badge>}
                    {...(waiting && !access
                        ? {
                              description:
                                  "Choose which websites Mira may use while this run waits.",
                          }
                        : {})}
                />
                <div className="flex flex-col gap-2 @min-[36rem]/browser-access:flex-row">
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
