import type { MiraRun } from "@homelab/contracts/mira";
import { Badge, Button, ErrorNotice, IconButton } from "@homelab/ui";
import { Globe, PanelRightOpen, Square } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { accessStatusTone } from "./statusTone";
import { browserAccessLabel, type useBrowserAccess } from "./useBrowserAccess";

/** Show the running browser with direct observation, takeover and stop controls.
 * @returns A compact session row only while a browser exists or cleanup is pending.
 */
export function BrowserAccessPanel({
    run,
    query,
    onView,
}: {
    readonly run: MiraRun | null;
    readonly query: ReturnType<typeof useBrowserAccess>;
    readonly onView: (id: string) => void;
}) {
    const access = query.data?.[0];
    const stop = useOperation((id: string, signal) =>
        api.mira.browser.stop.mutate({ id }, { signal })
    );
    if (!access || access.state === "closed")
        return query.error ? (
            <div className="shrink-0 border-t border-primary-700 px-4 py-2">
                <ErrorNotice error={query.error} />
            </div>
        ) : null;
    const label = browserAccessLabel(access, run, query.fresh);
    return (
        <section className="chat-column pb-1" aria-label="Browser session">
            <div className="flex min-w-0 items-center gap-2 rounded-xl border border-primary-700 bg-surface-card px-1.5 py-0.5">
                <Button
                    variant="ghost"
                    className="min-w-0 flex-1 justify-start"
                    disabled={access.state !== "active"}
                    aria-label="View browser"
                    onClick={() => onView(access.id)}
                >
                    <Globe size={16} aria-hidden="true" className="text-accent-300" />
                    Browser
                    <Badge tone={accessStatusTone(label)}>{label}</Badge>
                    <PanelRightOpen
                        size={16}
                        aria-hidden="true"
                        className="ml-auto text-primary-400"
                    />
                </Button>
                <IconButton
                    icon={Square}
                    label="Stop browser"
                    size="sm"
                    busy={stop.isPending}
                    disabled={access.state === "stopping"}
                    onClick={() => stop.mutate(access.id)}
                />
            </div>
            {query.error && <ErrorNotice error={query.error} />}
            {stop.error && <ErrorNotice error={stop.error} />}
        </section>
    );
}
