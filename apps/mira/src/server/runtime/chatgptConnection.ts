import type { MiraChatgptStatus } from "@homelab/contracts/miraChatgpt";

import type { CodexRuntime } from "./codexRuntime";
import { RuntimeResponseError } from "./responseError";

/** Verify stored authentication with an authenticated provider request, refreshing once if rejected.
 * @param runtime - Isolated native connection using the service's existing credential home.
 * @returns Verified connection state, current models and quota; never account identifiers or credentials.
 */
export async function inspectChatgpt(runtime: CodexRuntime) {
    const checkedAt = new Date().toISOString();
    try {
        const account = await runtime.account();
        if (!account.authenticated)
            return {
                status: { state: "disconnected", checkedAt } as MiraChatgptStatus,
                models: [],
                windows: [],
            };
        let windows;
        try {
            windows = await runtime.quota();
        } catch (error) {
            if (!(error instanceof RuntimeResponseError && error.authentication))
                throw error;
            const refreshed = await runtime.account(true);
            if (!refreshed.authenticated)
                return {
                    status: { state: "expired", checkedAt } as MiraChatgptStatus,
                    models: [],
                    windows: [],
                };
            windows = await runtime.quota();
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
