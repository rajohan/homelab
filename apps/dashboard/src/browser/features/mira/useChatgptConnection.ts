import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/** Observe the shared ChatGPT sign-in and expose explicit actions for the current operator.
 * @returns The current provider state, owned verification code and sign-in controls.
 */
export function useChatgptConnection() {
    const client = useQueryClient();
    const key = ["operations", "mira", "chatgpt"] as const;
    const status = useQuery({
        queryKey: key,
        queryFn: async ({ signal }) => {
            const next = await api.mira.chatgpt.status.query(undefined, { signal });
            const previous = client.getQueryData<typeof next>(key);
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
    const start = useOperation((_: void, signal) =>
        api.mira.chatgpt.login.mutate(undefined, { signal })
    );
    const cancel = useOperation((id: string, signal) =>
        api.mira.chatgpt.cancel.mutate({ id }, { signal })
    );
    const data = status.isError ? undefined : status.data;
    const login = data?.login;
    const pending =
        !!login &&
        ["requested", "starting", "waiting"].includes(login.state) &&
        data?.online === true;
    const expiredCode = pending && Date.parse(login.expiresAt) <= status.dataUpdatedAt;
    const active = pending && !expiredCode;
    const needsSignIn = data?.state === "expired" || data?.state === "disconnected";
    let label = "Checking";
    let description = "Checking the ChatGPT connection…";
    if (status.isError || data?.state === "error" || data?.online === false) {
        label = "Unavailable";
        description =
            data?.online === false
                ? "Mira is offline. Sign-in will be available when it reconnects."
                : "ChatGPT status could not be verified. Retrying automatically.";
    } else if (data) {
        if (data.state === "connected") {
            label = "Connected";
            description = "The shared ChatGPT sign-in is verified.";
        } else {
            label = data.state === "expired" ? "Sign-in expired" : "Signed out";
            description = "Sign in to resume messages waiting for ChatGPT.";
        }
    }
    if (active) {
        label = "Signing in";
        description = "Waiting for sign-in to finish.";
    } else if (expiredCode) {
        label = "Code expired";
        description = "Request a new code to continue.";
    } else if (needsSignIn && login?.state === "failed" && login.message) {
        description = login.message;
    }
    const canStart = !!(needsSignIn && data?.online && data.canManage && !pending);
    const canOpen = canStart || active;
    if (needsSignIn && data?.online && !data.canManage && !active)
        description = "An operator with worker-control permission can reconnect ChatGPT.";
    const startLabel = data?.state === "expired" ? "Sign in again" : "Sign in";
    const action = active ? "Continue sign-in" : startLabel;
    return {
        data,
        login,
        active,
        canStart,
        canOpen,
        needsSignIn,
        label,
        description,
        action,
        start,
        cancel,
        showNotice: active || needsSignIn || label === "Unavailable",
    };
}

export type ChatgptConnectionState = ReturnType<typeof useChatgptConnection>;
