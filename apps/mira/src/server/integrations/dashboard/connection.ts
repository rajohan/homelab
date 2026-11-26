import * as v from "valibot";

import { MiraFailure } from "../../data/context";
import { integrationJson } from "../http";
import type { MiraDashboardRoute } from "./catalog";

export interface MiraDashboardConfiguration {
    owner: string;
    origin: string;
    token: string;
}

/** Read the dedicated dashboard machine credential and its single operator binding.
 * @param environment - Service environment, never inherited by a model child.
 * @returns The explicit HTTPS connection, or undefined before the token is provisioned.
 */
export function miraDashboardConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): MiraDashboardConfiguration | undefined {
    const token = environment.HOMELAB_MIRA_DASHBOARD_TOKEN;
    if (!token) return;
    const owner = environment.HOMELAB_MIRA_DASHBOARD_OWNER;
    const origin = environment.HOMELAB_MIRA_DASHBOARD_ORIGIN;
    const url = origin && URL.canParse(origin) ? new URL(origin) : null;
    if (
        !owner ||
        !/^[\u0021-\u007E]{1,320}$/.test(owner) ||
        !/^hlb_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token) ||
        !url ||
        url.protocol !== "https:" ||
        (origin !== url.origin && origin !== url.origin + "/")
    )
        throw new Error(
            "Mira dashboard access requires an operator, an HTTPS origin and a dashboard machine token."
        );
    return { owner, origin: url.origin, token };
}

/** Read a single tRPC result from the configured dashboard. The caller selects a fixed operation.
 * @param connection - Trusted service-only URL and credential.
 * @param route - Procedure selected by the service-owned operation catalog.
 * @param write - Whether this procedure is a mutation.
 * @param input - Validated at the dashboard boundary using the normal procedure contract.
 * @param signal - Run cancellation and per-request deadline.
 * @param request - HTTP transport, replaceable during isolated verification.
 * @returns The JSON representation of the dashboard's SuperJSON result.
 */
export async function requestDashboard(
    connection: MiraDashboardConfiguration,
    route: MiraDashboardRoute,
    write: boolean,
    input: Record<string, unknown> | undefined,
    signal: AbortSignal,
    request: typeof fetch
): Promise<unknown> {
    const url = new URL("/api/automation/" + route, connection.origin);
    const body = input === undefined ? undefined : JSON.stringify({ json: input });
    if (body && Buffer.byteLength(body) > 8192)
        throw new MiraFailure("BAD_REQUEST", "The dashboard request is too large.");
    if (!write && body) url.searchParams.set("input", body);
    const response = await request(url, {
        method: write ? "POST" : "GET",
        headers: {
            Authorization: "Bearer " + connection.token,
            ...(write ? { "Content-Type": "application/json" } : {}),
        },
        ...(write && body ? { body } : {}),
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
        await response.body?.cancel();
        switch (response.status) {
            case 401:
            case 403: {
                throw new MiraFailure(
                    "FORBIDDEN",
                    "The dashboard refused this machine credential or its permissions."
                );
            }
            case 400:
            case 404:
            case 409:
            case 412:
            case 429: {
                throw new MiraFailure(
                    "PRECONDITION_FAILED",
                    `Dashboard request declined (HTTP ${response.status}). Check the arguments, current state and account permissions.`
                );
            }
            default: {
                // A server or transport failure cannot prove a submitted mutation did not commit.
                throw new Error("The dashboard did not confirm this operation.");
            }
        }
    }
    const envelope = v.safeParse(
        v.object({
            result: v.object({ data: v.object({ json: v.nonOptional(v.unknown()) }) }),
        }),
        await integrationJson(response, 2 * 1024 * 1024)
    );
    if (!envelope.success) throw new Error("The dashboard returned an invalid result.");
    return envelope.output.result.data.json;
}
