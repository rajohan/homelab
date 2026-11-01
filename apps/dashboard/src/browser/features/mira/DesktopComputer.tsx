import { Button, ErrorNotice, LoadingState, SectionHeader } from "@homelab/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Plug, Square, Download, Unplug } from "lucide-react";

import { hasDesktopBridge, requestDesktop } from "./desktopClient";

/**
 * Render Windows-only connection controls using the shared Settings design.
 * @returns Local connection controls, or nothing in a normal browser.
 */
export function DesktopComputer() {
    const queryClient = useQueryClient();
    const state = useQuery({
        queryKey: ["mira", "desktop"],
        queryFn: ({ signal }) => requestDesktop({ action: "state" }, signal),
        enabled: hasDesktopBridge(),
        refetchInterval: 2000,
        retry: false,
    });
    const action = useMutation({
        mutationFn: (action: "connect" | "stop" | "forget" | "update") =>
            requestDesktop({ action }),
        onSuccess: (value) => queryClient.setQueryData(["mira", "desktop"], value),
    });
    if (!hasDesktopBridge()) return null;
    const current = state.data;
    return (
        <section className="@container/desktop space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
            <SectionHeader
                title="This Windows PC"
                icon={Monitor}
                description={current?.message ?? "Checking the local connection…"}
            />
            {state.isPending && <LoadingState label="Checking Windows app…" />}
            {(state.error ?? action.error) && (
                <ErrorNotice error={state.error ?? action.error} />
            )}
            {current && (
                <>
                    {!current.computerId && (
                        <p className="text-sm text-primary-400">
                            Use Pair computer to connect this PC. Chat and automations
                            work without PC pairing.
                        </p>
                    )}
                    <div className="grid gap-2 @min-[40rem]/desktop:grid-cols-4">
                        <Button
                            variant="secondary"
                            fullWidth
                            disabled={!current.canStart || action.isPending}
                            onClick={() => action.mutate("connect")}
                        >
                            <Plug size={16} aria-hidden="true" />
                            Connect
                        </Button>
                        <Button
                            variant="secondary"
                            fullWidth
                            disabled={!current.canStop || action.isPending}
                            onClick={() => action.mutate("stop")}
                        >
                            <Square size={16} aria-hidden="true" />
                            Stop connection
                        </Button>
                        <Button
                            variant="secondary"
                            fullWidth
                            disabled={!current.canUpdate || action.isPending}
                            onClick={() => action.mutate("update")}
                        >
                            <Download size={16} aria-hidden="true" />
                            Update app
                        </Button>
                        <Button
                            variant="secondary"
                            fullWidth
                            disabled={
                                !current.canStart ||
                                !current.computerId ||
                                action.isPending
                            }
                            onClick={() => action.mutate("forget")}
                        >
                            <Unplug size={16} aria-hidden="true" />
                            Remove pairing
                        </Button>
                    </div>
                    <p className="text-sm text-primary-400">
                        Screen access still requires your local approval. Stopping the
                        connection leaves server work running.
                    </p>
                </>
            )}
        </section>
    );
}
