import { miraBrowserTabCommandSchema } from "@homelab/contracts/miraBrowser";
import * as v from "valibot";

import { openBrowserConnection } from "./connection";
import {
    BrowserDownloadReceiver,
    browserDownloadHeaderSchema,
    browserDownloadCount,
    browserDownloadTotal,
} from "./downloadTransfer";
import { browserDriverVersion } from "./driver";
import { browserUrl } from "./policy";
import {
    browserUploadActionSchema,
    browserUploadFileSchema,
    type BrowserUploadFile,
} from "./upload";
import { browserUploadParts } from "./uploadTransfer";
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
    let downloadCount = 0,
        downloadBytes = 0;
    let observed:
        | {
              id: string;
              refs: Map<string, readonly string[]>;
              time: number;
              maxAge: number;
              downloads: Set<string>;
          }
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
                driver: v.literal(browserDriverVersion),
            }),
            await connection.request(
                { method: "initialize", params: grant },
                owner,
                60_000
            )
        )
    );
    const observe = async (
        request: unknown,
        operation: AbortSignal,
        operator: boolean
    ) => {
        observed = undefined;
        const frame = browserWorkerFrame(
            await connection.request(request, operation),
            grant.origins
        );
        observed = {
            id: frame.observationId,
            refs: new Map(frame.refs.map((item) => [item.ref, [...item.actions]])),
            time: now(),
            maxAge: operator ? 60_000 : 10_000,
            downloads: new Set(
                operator
                    ? frame.refs
                          .filter(
                              (item) =>
                                  item.role === "link" && item.actions.includes("click")
                          )
                          .map((item) => item.ref)
                    : []
            ),
        };
        return frame;
    };
    return {
        signal: connection.signal,
        observe: (operation: AbortSignal, operator = false) =>
            run(operation, async () => {
                return observe(
                    { method: "observe", params: operator ? { operator: true } : {} },
                    operation,
                    operator
                );
            }),
        tabs: (input: unknown, operation: AbortSignal, operator = false) =>
            run(operation, async () => {
                const command = v.parse(miraBrowserTabCommandSchema, input);
                if (command.action === "open") browserUrl(command.url, grant.origins);
                return observe(
                    { method: "tabs", params: { input: command, operator } },
                    operation,
                    operator
                );
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
                    now() - previous.time >= previous.maxAge ||
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
        download: (input: unknown, operation: AbortSignal) =>
            run(operation, async () => {
                const previous = observed;
                observed = undefined;
                const action = v.parse(browserUploadActionSchema, input);
                if (
                    !grant.downloads ||
                    grant.mode !== "control" ||
                    !previous ||
                    previous.id !== action.observationId ||
                    now() - previous.time < 0 ||
                    now() - previous.time >= previous.maxAge ||
                    !previous.downloads.has(action.ref) ||
                    ++downloadCount > browserDownloadCount
                )
                    throw new Error(
                        "Download requires an unused operator link observation."
                    );
                const header = v.parse(
                    browserDownloadHeaderSchema,
                    await connection.request(
                        { method: "downloadBegin", params: action },
                        operation
                    )
                );
                downloadBytes += header.size;
                if (downloadBytes > browserDownloadTotal)
                    throw new Error("Browser download lifetime quota exceeded.");
                const receiver = new BrowserDownloadReceiver(header);
                for (let offset = 0; offset < header.size; offset += 24 * 1024) {
                    operation.throwIfAborted();
                    receiver.accept(
                        await connection.request(
                            { method: "downloadPart", params: { offset } },
                            operation
                        )
                    );
                }
                const file = receiver.finish();
                v.parse(
                    v.strictObject({ accepted: v.literal(true) }),
                    await connection.request(
                        { method: "downloadFinish", params: {} },
                        operation
                    )
                );
                return file;
            }),
        upload: (input: unknown, file: BrowserUploadFile, operation: AbortSignal) => {
            const action = v.parse(browserUploadActionSchema, input);
            const selected = v.parse(browserUploadFileSchema, file);
            const copy = { ...selected, bytes: Uint8Array.from(selected.bytes) };
            return run(operation, async () => {
                const previous = observed;
                observed = undefined;
                if (
                    !grant.uploads ||
                    grant.mode !== "control" ||
                    !previous ||
                    previous.id !== action.observationId ||
                    now() - previous.time < 0 ||
                    now() - previous.time >= previous.maxAge ||
                    !previous.refs.get(action.ref)?.includes("upload") ||
                    copy.bytes.length !== copy.size ||
                    new Bun.CryptoHasher("sha256").update(copy.bytes).digest("hex") !==
                        copy.sha256
                )
                    throw new Error(
                        "Upload requires approved bytes and a current file input."
                    );
                const accepted = v.strictObject({ accepted: v.literal(true) });
                v.parse(
                    accepted,
                    await connection.request(
                        {
                            method: "uploadBegin",
                            params: {
                                input: action,
                                file: {
                                    name: copy.name,
                                    size: copy.size,
                                    sha256: copy.sha256,
                                },
                            },
                        },
                        operation
                    )
                );
                for (const part of browserUploadParts(copy))
                    v.parse(
                        accepted,
                        await connection.request(
                            { method: "uploadPart", params: part },
                            operation
                        )
                    );
                if (now() - previous.time >= previous.maxAge)
                    throw new Error("Upload observation expired during transfer.");
                return v.parse(
                    v.strictObject({ effect: v.literal("unverified") }),
                    await connection.request(
                        { method: "uploadFinish", params: {} },
                        operation
                    )
                );
            });
        },
        close,
    };
}
