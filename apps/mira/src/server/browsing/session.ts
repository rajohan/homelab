import type { openBrowserWorker } from "./process";
import type { BrowserUploadFile } from "./upload";

type Port = Awaited<ReturnType<typeof openBrowserWorker>>;
interface Authority {
    check: (mode: "view" | "control") => Promise<{ validForMs: number }>;
    release: () => Promise<void>;
}

const stopped = () =>
    new Error(
        "Browser access stopped; the operation outcome may be unknown. Do not replay input."
    );

function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const stop = () => reject(new Error("Browser access stopped."));
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        void work
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", stop));
    });
}

/**
 * Supervise one claimed browser with expiring authority throughout startup, idle time and operations.
 * @param open - Trusted factory bound to fixed configuration and the claimed policy; never a model tool.
 * @param access - Private claim checks and release after confirmed container absence.
 * @param owner - Permanent host/run cancellation, including during initialization.
 * @returns A serial port with redacted failures and a cleanup completion promise; uncertain cleanup retains the claim.
 */
export async function openBrowserSession(
    open: (signal: AbortSignal) => Promise<Port>,
    access: Authority,
    owner: AbortSignal
) {
    const controller = new AbortController();
    const { signal } = controller;
    const completion = Promise.withResolvers<void>();
    // Consumers can await closed; automatic retirement must not create an unhandled rejection.
    void completion.promise.catch(() => {});
    let opening: Promise<Port> | undefined;
    let port: Port | undefined;
    let attempted = false;
    let busy = false;
    let retired = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let deadline = performance.now() + 5000;
    const retire = () => {
        if (retired) return;
        retired = true;
        controller.abort();
        clearTimeout(poll);
        clearTimeout(expiry);
        owner.removeEventListener("abort", retire);
        port?.signal.removeEventListener("abort", retire);
        void (async () => {
            try {
                if (opening) {
                    let acquired: Port;
                    try {
                        acquired = await opening;
                    } catch {
                        // A failed factory has not handed us proof of process-tree removal.
                        if (attempted)
                            throw new Error("Unconfirmed browser startup cleanup.");
                        await access.release();
                        return;
                    }
                    await acquired.close();
                }
                await access.release();
            } catch {
                throw new Error(
                    "Browser cleanup could not be confirmed; access remains reserved."
                );
            }
        })().then(completion.resolve, completion.reject);
    };
    const armExpiry = () => {
        clearTimeout(expiry);
        const remaining = deadline - performance.now();
        if (remaining <= 0) retire();
        else {
            expiry = setTimeout(retire, remaining);
            expiry.unref();
        }
    };
    const check = async (mode: "view" | "control") => {
        signal.throwIfAborted();
        if (performance.now() >= deadline) throw stopped();
        const started = performance.now(),
            limit = deadline;
        // Other checks may renew the shared permit, but cannot prolong this query.
        const pendingExpiry = setTimeout(retire, Math.max(1, limit - started));
        pendingExpiry.unref();
        try {
            const permit = await interrupted(access.check(mode), signal);
            signal.throwIfAborted();
            if (
                !Number.isInteger(permit.validForMs) ||
                permit.validForMs < 1 ||
                permit.validForMs > 5000
            )
                throw stopped();
            // Query/transport time consumes the permit instead of extending it on receipt.
            const next = started + permit.validForMs;
            if (performance.now() >= Math.min(limit, next)) throw stopped();
            deadline = next;
            armExpiry();
            signal.throwIfAborted();
        } finally {
            clearTimeout(pendingExpiry);
        }
    };
    const watch = () => {
        if (signal.aborted) return;
        poll = setTimeout(
            () => {
                void check("view").then(watch, retire);
            },
            Math.max(1, Math.min(1000, (deadline - performance.now()) / 2))
        );
        poll.unref();
    };
    const close = async () => {
        retire();
        await completion.promise;
    };
    owner.addEventListener("abort", retire, { once: true });
    armExpiry();
    if (owner.aborted) retire();
    try {
        await check("view");
        watch();
        opening = Promise.resolve().then(() => {
            signal.throwIfAborted();
            attempted = true;
            return open(signal);
        });
        port = await opening;
        port.signal.addEventListener("abort", retire, { once: true });
        if (signal.aborted || port.signal.aborted) throw stopped();
        await check("view");
    } catch {
        await close();
        throw stopped();
    }
    const active = port;
    const run = async <T>(
        mode: "view" | "control",
        operation: AbortSignal,
        work: (signal: AbortSignal) => Promise<T>
    ) => {
        if (busy) throw new Error("The browser already has an active operation.");
        busy = true;
        operation.addEventListener("abort", retire, { once: true });
        try {
            if (operation.aborted) retire();
            await check(mode);
            signal.throwIfAborted();
            const result = await interrupted(work(signal), signal);
            await check(mode);
            return result;
        } catch {
            await close();
            throw stopped();
        } finally {
            operation.removeEventListener("abort", retire);
            busy = false;
        }
    };
    return {
        signal,
        closed: completion.promise,
        observe: (operation: AbortSignal, operator = false) =>
            run("view", operation, (s) => active.observe(s, operator)),
        tabs: (input: unknown, operation: AbortSignal, operator = false) => {
            const command = structuredClone(input);
            return run("view", operation, (s) => active.tabs(command, s, operator));
        },
        navigate: (url: unknown, operation: AbortSignal) =>
            run("view", operation, (s) => active.navigate(url, s)),
        act: (input: unknown, operation: AbortSignal) => {
            const snapshot = structuredClone(input);
            return run("control", operation, (s) => active.act(snapshot, s));
        },
        download: (input: unknown, operation: AbortSignal) => {
            const snapshot = structuredClone(input);
            return run("control", operation, (s) => active.download(snapshot, s));
        },
        upload: (input: unknown, file: BrowserUploadFile, operation: AbortSignal) => {
            const snapshot = structuredClone(input);
            const selected = { ...file, bytes: Uint8Array.from(file.bytes) };
            return run("control", operation, (s) => active.upload(snapshot, selected, s));
        },
        close,
    };
}
