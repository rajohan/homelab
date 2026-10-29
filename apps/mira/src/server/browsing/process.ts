import * as v from "valibot";

import { computerDriverVersion } from "../computer/policy";
import { openBrowserConnection } from "./connection";
import { browserUrl } from "./policy";
import { browserActionSchema, browserWorkerFrame, browserWorkerGrant } from "./wire";

/**
 * Bind the fixed worker protocol to a container and a trusted host-owned browser grant.
 * @param configuration - Local Engine socket and installed immutable image ID; never model arguments.
 * @param grantInput - Approved origins, initial URL and view/control ceiling, fixed for this lifetime.
 * @param owner - Permanent cancellation of the entire owner/run lifetime.
 * @param connect - Private transport factory; synthetic replacement is for unit qualification only.
 * @param now - Monotonic clock for the latest single-use observation.
 * @returns A typed browser port; close proves container removal or preserves cleanup failure.
 */
export async function openBrowserWorker(
    configuration: unknown,
    grantInput: unknown,
    owner: AbortSignal,
    connect: (
        configuration: unknown,
        signal: AbortSignal
    ) => Promise<
        Pick<
            Awaited<ReturnType<typeof openBrowserConnection>>,
            "request" | "close" | "signal"
        >
    > = openBrowserConnection,
    now: () => number = () => performance.now()
) {
    owner.throwIfAborted();
    const grant = browserWorkerGrant(grantInput);
    const connection = await connect(configuration, owner);
    let busy = false;
    let observed:
        | { id: string; refs: Map<string, readonly string[]>; time: number }
        | undefined;
    const close = () => {
        observed = undefined;
        return connection.close();
    };
    const run = async <T>(operation: AbortSignal, work: () => Promise<T>) => {
        if (busy) throw new Error("The browser already has an active operation.");
        busy = true;
        try {
            owner.throwIfAborted();
            operation.throwIfAborted();
            connection.signal.throwIfAborted();
            const result = await work();
            owner.throwIfAborted();
            operation.throwIfAborted();
            connection.signal.throwIfAborted();
            return result;
        } catch {
            await close();
            throw new Error(
                "Browser worker returned no valid result; its outcome may be unknown. Do not replay input."
            );
        } finally {
            busy = false;
        }
    };
    await run(owner, async () =>
        v.parse(
            v.strictObject({
                version: v.literal(1),
                driver: v.literal(computerDriverVersion),
            }),
            await connection.request({ method: "initialize", params: grant }, owner)
        )
    );
    return {
        observe: (operation: AbortSignal) =>
            run(operation, async () => {
                observed = undefined;
                const frame = browserWorkerFrame(
                    await connection.request(
                        { method: "observe", params: {} },
                        operation
                    ),
                    grant.origins
                );
                observed = {
                    id: frame.observationId,
                    refs: new Map(
                        frame.refs.map((item) => [item.ref, [...item.actions]])
                    ),
                    time: now(),
                };
                return frame;
            }),
        navigate: (url: unknown, operation: AbortSignal) =>
            run(operation, async () => {
                observed = undefined;
                const result = v.parse(
                    v.strictObject({ url: v.string() }),
                    await connection.request(
                        {
                            method: "navigate",
                            params: { url: browserUrl(url, grant.origins) },
                        },
                        operation
                    )
                );
                return { url: browserUrl(result.url, grant.origins) };
            }),
        act: (input: unknown, operation: AbortSignal) =>
            run(operation, async () => {
                const previous = observed;
                observed = undefined;
                const action = v.parse(browserActionSchema, input);
                if (
                    grant.mode !== "control" ||
                    !previous ||
                    previous.id !== action.observationId ||
                    now() - previous.time < 0 ||
                    now() - previous.time > 10_000 ||
                    !previous.refs.get(action.ref)?.includes(action.action)
                )
                    throw new Error(
                        "Browser input requires a fresh permitted observation."
                    );
                return v.parse(
                    v.strictObject({ effect: v.literal("unverified") }),
                    await connection.request({ method: "act", params: action }, operation)
                );
            }),
        close,
    };
}
