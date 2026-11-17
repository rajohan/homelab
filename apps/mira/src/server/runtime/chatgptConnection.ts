import type { MiraChatgptStatus } from "@homelab/contracts/miraChatgpt";

import type { CodexRuntime } from "./codexRuntime";
import { RuntimeResponseError } from "./responseError";

/** Verify managed authentication independently from optional quota telemetry.
 * @param runtime - Isolated native connection using the service's existing credential home.
 * @param refreshToken - Proactively renew during periodic inspection and login confirmation; turns reuse that check unless authorization is rejected.
 * @returns Verified connection state, current models and optional quota; never account identifiers or credentials.
 */
export async function inspectChatgpt(runtime: CodexRuntime, refreshToken = true) {
    const checkedAt = new Date().toISOString();
    try {
        const account = await runtime.account(refreshToken);
        if (!account.authenticated)
            return {
                status: { state: "disconnected", checkedAt } as MiraChatgptStatus,
                models: [],
                windows: [],
            };
        let windows: Awaited<ReturnType<CodexRuntime["quota"]>> = [];
        try {
            windows = await runtime.quota();
        } catch (error) {
            if (error instanceof RuntimeResponseError && error.authentication) {
                if (refreshToken) throw error;
                const refreshed = await runtime.account(true);
                if (!refreshed.authenticated)
                    return {
                        status: { state: "expired", checkedAt } as MiraChatgptStatus,
                        models: [],
                        windows: [],
                    };
                windows = await runtime.quota().catch((error: unknown) => {
                    if (error instanceof RuntimeResponseError && error.authentication)
                        throw error;
                    return [];
                });
            }
            // A quota service outage does not invalidate verified credentials.
        }
        return {
            status: { state: "connected", checkedAt } as MiraChatgptStatus,
            models: await runtime.models(),
            windows,
        };
    } catch (error) {
        return {
            status: {
                state:
                    error instanceof RuntimeResponseError && error.authentication
                        ? "expired"
                        : "error",
                checkedAt,
            } as MiraChatgptStatus,
            models: [],
            windows: [],
        };
    }
}
