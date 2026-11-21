import { Button, ErrorNotice } from "@homelab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/** Show verified ChatGPT health and the native device-code login inside the existing dashboard.
 * @returns Current status, an owned one-time code and an explicit success acknowledgement.
 */
export function ChatgptConnection({
    alertsOnly = false,
}: { readonly alertsOnly?: boolean } = {}) {
    const client = useQueryClient();
    const status = useQuery({
        queryKey: ["operations", "mira", "chatgpt"],
        queryFn: async () => {
            const next = await api.mira.chatgpt.status.query();
            const previous = client.getQueryData<typeof next>([
                "operations",
                "mira",
                "chatgpt",
            ]);
            if (
                next.state === "connected" &&
                (previous?.state !== "connected" ||
                    previous.login?.requestId !== next.login?.requestId)
            ) {
                void client.invalidateQueries({
                    queryKey: ["operations", "mira", "models"],
                });
                void client.invalidateQueries({
                    queryKey: ["operations", "mira", "status"],
                });
            }
            return next;
        },
        refetchInterval: 2000,
    });
    const start = useOperation(() => api.mira.chatgpt.login.mutate());
    const cancel = useOperation((id: string) => api.mira.chatgpt.cancel.mutate({ id }));
    const connection = status.data;
    const login = connection?.login;
    const active =
        !!login &&
        ["requested", "starting", "waiting"].includes(login.state) &&
        connection?.online === true;
    const busy = start.isPending || cancel.isPending;
    const needsSignIn =
        connection?.state === "disconnected" || connection?.state === "expired";
    if (
        alertsOnly &&
        !needsSignIn &&
        !active &&
        !start.error &&
        !cancel.error &&
        !login?.message
    )
        return null;
    return (
        <div className="shrink-0 space-y-2 p-2 text-sm leading-relaxed text-primary-300">
            <output className="block">
                {status.isError
                    ? "ChatGPT connection status could not be checked. Retrying…"
                    : (connection?.message ?? "Checking ChatGPT connection…")}
            </output>
            {active ? (
                <div className="space-y-2">
                    {login.verificationUrl && login.userCode ? (
                        <>
                            <p>Open the sign-in page and enter this one-time code:</p>
                            <p className="font-mono text-base font-semibold text-primary-50 select-all">
                                {login.userCode}
                            </p>
                            <a
                                className="text-accent-300 underline"
                                href={login.verificationUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Sign in to ChatGPT
                            </a>
                            <p>
                                Waiting for you to finish signing in. This page updates
                                automatically.
                            </p>
                        </>
                    ) : (
                        <p>Preparing ChatGPT sign-in…</p>
                    )}
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => cancel.mutate(login.requestId)}
                    >
                        Cancel sign-in
                    </Button>
                </div>
            ) : (
                <>
                    {login?.message &&
                        ((login.state === "completed" &&
                            connection?.state === "connected") ||
                            (login.state === "failed" && needsSignIn)) && (
                            <output className="block">{login.message}</output>
                        )}
                    {needsSignIn && connection?.canManage && (
                        <Button
                            size="sm"
                            variant="secondary"
                            busy={busy}
                            disabled={!connection.online}
                            onClick={() => start.mutate(undefined)}
                        >
                            {connection.state === "disconnected"
                                ? "Sign in to ChatGPT"
                                : "Sign in again"}
                        </Button>
                    )}
                    {needsSignIn && connection && !connection.canManage && (
                        <p>
                            An operator with worker-control permission can reconnect the
                            shared ChatGPT account.
                        </p>
                    )}
                </>
            )}
            {(start.error || cancel.error) && (
                <ErrorNotice error={start.error ?? cancel.error} />
            )}
        </div>
    );
}
