import { setTimeout as delay } from "node:timers/promises";

import type { SQL } from "bun";

import { runtimeEnvironment } from "../config/environment";
import { inspectChatgpt } from "../runtime/chatgptConnection";
import { CodexRuntime } from "../runtime/codexRuntime";
import { pilotArguments, type PilotConfig } from "../runtime/configuration";

/** Process the dashboard's single shared-provider login with the official native device-code flow.
 * @param options - Executor database, isolated runtime paths, worker identity and shutdown signal.
 * @returns Completion at shutdown; the callback refreshes models and dispatches preserved queue entries.
 */
export async function runChatgptLogins(options: {
    client: SQL;
    config: PilotConfig;
    workerId: string;
    signal: AbortSignal;
    changed: () => void;
}): Promise<void> {
    const { client, config, workerId, signal } = options;
    await client`UPDATE mira_chatgpt_login SET state='failed',verification_url=NULL,user_code=NULL,message='Sign-in interrupted by executor restart. Sign in again.' WHERE state IN ('starting','waiting') AND worker_id IS DISTINCT FROM ${workerId}`;
    while (!signal.aborted) {
        await client`UPDATE mira_chatgpt_login SET state='failed',verification_url=NULL,user_code=NULL,message='The sign-in code expired. Sign in again for a new code.' WHERE state IN ('requested','starting','waiting') AND expires_at<=now()`;
        const [request] = await client<
            { requestId: string; expiresAt: Date }[]
        >`UPDATE mira_chatgpt_login SET state='starting',worker_id=${workerId} WHERE id=1 AND state='requested' AND expires_at>now() RETURNING request_id AS "requestId",expires_at AS "expiresAt"`;
        if (request) {
            const cancelled = new AbortController();
            const loginSignal = AbortSignal.any([
                signal,
                cancelled.signal,
                AbortSignal.timeout(
                    Math.max(1, new Date(request.expiresAt).getTime() - Date.now())
                ),
            ]);
            let runtime: CodexRuntime | undefined;
            let polling = false;
            let check: Promise<void> = Promise.resolve();
            const timer = setInterval(() => {
                if (polling) return;
                polling = true;
                check = client<
                    { active: boolean }[]
                >`SELECT state IN ('starting','waiting') AND expires_at>now() AND request_id=${request.requestId} AND worker_id=${workerId} AS active FROM mira_chatgpt_login WHERE id=1`
                    .then((rows) => {
                        if (!rows[0]?.active) cancelled.abort();
                        return;
                    })
                    .catch(() => cancelled.abort())
                    .finally(() => {
                        polling = false;
                    });
            }, 1000);
            try {
                runtime = await CodexRuntime.connect({
                    command: config.command,
                    args: pilotArguments(),
                    cwd: config.workspace,
                    env: runtimeEnvironment(config),
                    signal: loginSignal,
                    requestTimeoutMs: 20_000,
                });
                const success = await runtime.login(async (code) => {
                    const rows = await client<
                        { id: number }[]
                    >`UPDATE mira_chatgpt_login SET state='waiting',verification_url=${code.verificationUrl},user_code=${code.userCode} WHERE id=1 AND request_id=${request.requestId} AND worker_id=${workerId} AND state='starting' AND expires_at>now() RETURNING id`;
                    if (!rows[0]) {
                        cancelled.abort();
                        throw new Error("Login request cancelled.");
                    }
                }, loginSignal);
                if (!success) throw new Error("Login was not completed.");
                const verified = await inspectChatgpt(runtime);
                if (verified.status.state !== "connected")
                    throw new Error("Login connection could not be verified.");
                await client`UPDATE mira_chatgpt_login SET state='completed',verification_url=NULL,user_code=NULL,message='ChatGPT sign-in succeeded. Waiting messages will continue automatically.' WHERE id=1 AND request_id=${request.requestId} AND worker_id=${workerId} AND state='waiting' AND expires_at>now()`;
            } catch {
                await client`UPDATE mira_chatgpt_login SET state='failed',verification_url=NULL,user_code=NULL,message='ChatGPT sign-in could not be verified or the code expired. Try signing in again.' WHERE id=1 AND request_id=${request.requestId} AND worker_id=${workerId} AND state IN ('starting','waiting')`;
            } finally {
                clearInterval(timer);
                await check;
                await runtime?.close();
                options.changed();
            }
        }
        try {
            await delay(1000, undefined, { signal });
        } catch {
            if (!signal.aborted) throw new Error("Login polling stopped.");
        }
    }
}
