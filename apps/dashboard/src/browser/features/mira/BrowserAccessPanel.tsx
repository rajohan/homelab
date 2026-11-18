import type { MiraRun } from "@homelab/contracts/mira";
import { Badge, Button, ErrorNotice } from "@homelab/ui";
import { Globe, Square } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserConsoleDialog } from "./BrowserConsoleDialog";
import { accessStatusTone } from "./statusTone";
import { browserAccessLabel, useBrowserAccess } from "./useBrowserAccess";

/** Show the running browser with direct observation, takeover and stop controls.
 * @returns A compact session row only while a browser exists or cleanup is pending.
 */
export function BrowserAccessPanel({ run }: { readonly run: MiraRun | null }) {
    const [showBrowser, setShowBrowser] = useState(false);
    const query = useBrowserAccess(run);
    const access = query.data?.[0];
    const stop = useOperation((id: string, signal) =>
        api.mira.browser.stop.mutate({ id }, { signal })
    );
    if (!access || access.state === "closed") return null;
    const label = browserAccessLabel(access, run, query.fresh);
    return (
        <section
            className="shrink-0 border-t border-primary-700 px-4 py-2"
            aria-label="Browser session"
        >
            <div className="flex flex-wrap items-center gap-2">
                <Globe size={16} aria-hidden="true" />
                <span className="text-sm font-medium">Browser</span>
                <Badge tone={accessStatusTone(label)}>{label}</Badge>
                <div className="ml-auto flex flex-wrap gap-2">
                    {access.state === "active" && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setShowBrowser(true)}
                        >
                            View browser
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        size="sm"
                        busy={stop.isPending}
                        disabled={access.state === "stopping"}
                        onClick={() => stop.mutate(access.id)}
                    >
                        <Square size={14} aria-hidden="true" />
                        Stop browser
                    </Button>
                </div>
            </div>
            {query.error && <ErrorNotice error={query.error} />}
            {stop.error && <ErrorNotice error={stop.error} />}
            {showBrowser && access.state === "active" && (
                <BrowserConsoleDialog
                    key={access.id}
                    access={access}
                    onClose={() => setShowBrowser(false)}
                />
            )}
        </section>
    );
}
