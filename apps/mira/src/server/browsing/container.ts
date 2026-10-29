import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { browserDockerRequest, type BrowserDockerRequest } from "./docker";

const imageId = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
const containerId = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const configuration = v.strictObject({
    socketPath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    imageId,
});
const inspection = v.object({
    Id: containerId,
    Image: imageId,
    Config: v.object({ Labels: v.record(v.string(), v.string()) }),
});
const ownerLabel = "io.homelab.mira.browser-owner";

/** A container whose absence could not be proved; replacement must wait for reconciliation. */
export class BrowserContainerCleanupError extends Error {
    readonly containerName: string;
    /**
     * Retain only the generated recovery name, never daemon output or browser content.
     * @param containerName - Host-generated name to reconcile before replacement.
     */
    constructor(containerName: string) {
        super("Browser container cleanup could not be confirmed.");
        this.containerName = containerName;
    }
}

/**
 * Build an offline, unprivileged browser container with a daemon-enforced process boundary.
 * @param image - Already-installed immutable image ID, selected by the trusted updater/host.
 * @param owner - Unpredictable host-generated lifetime identifier.
 * @returns Fixed resource limits and a hard deadline around the packaged worker entrypoint.
 */
export function browserContainerSpec(image: string, owner: string) {
    v.parse(imageId, image);
    v.parse(v.pipe(v.string(), v.uuid()), owner);
    return {
        Image: image,
        User: "1000:1000",
        Entrypoint: ["/usr/bin/timeout"],
        Cmd: ["--signal=KILL", "305s", "/usr/local/bin/mira-browser"],
        Labels: { [ownerLabel]: owner },
        OpenStdin: true,
        StdinOnce: true,
        Tty: false,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: false,
        NetworkDisabled: true,
        HostConfig: {
            AutoRemove: true,
            Init: true,
            NetworkMode: "none",
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            Memory: 1536 * 1024 * 1024,
            NanoCpus: 2_000_000_000,
            PidsLimit: 256,
            Tmpfs: {
                "/tmp": "rw,nosuid,nodev,size=256m",
                "/home/bun": "rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
            },
            LogConfig: { Type: "none", Config: {} },
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Binds: [],
            PortBindings: {},
        },
    };
}

/**
 * Create a private container lease; no browser runs before the caller explicitly starts it.
 * @param input - Trusted local Unix socket and preinstalled immutable browser image ID.
 * @param signal - Permanent host cancellation, including during creation.
 * @param transport - Synthetic replacement for lifecycle tests; never model-selected.
 * @returns One start-only lease. Close proves container absence or rejects permanently.
 */
export async function prepareBrowserContainer(
    input: unknown,
    signal: AbortSignal,
    transport?: BrowserDockerRequest
) {
    signal.throwIfAborted();
    const config = v.parse(configuration, input);
    const metadata = path.isAbsolute(config.socketPath)
        ? await lstat(config.socketPath)
        : null;
    if (
        !metadata?.isSocket() ||
        (await realpath(config.socketPath)) !== config.socketPath
    )
        throw new Error("The browser host requires a canonical local Docker socket.");
    const call = transport ?? browserDockerRequest(config.socketPath);
    const owner = randomUUID();
    const name = `mira-browser-${owner}`;
    let id: string | undefined;
    let creationIssued = false;
    let creationSettled = false;
    let stopped = false;
    let started = false;
    let closing: Promise<void> | undefined;
    let active = Promise.resolve();
    const controller = new AbortController();
    const inspect = async (reference: string) => {
        const response = await call("GET", `/containers/${reference}/json`);
        if (response.status === 404) return null;
        if (response.status !== 200)
            throw new Error("Browser container inspection failed.");
        const found = v.parse(inspection, response.body);
        if (
            found.Config.Labels[ownerLabel] !== owner ||
            found.Image !== config.imageId ||
            (id && found.Id !== id)
        )
            throw new Error("The browser container ownership does not match.");
        return found.Id;
    };
    const remove = async () => {
        if (!creationIssued) return;
        const found = await inspect(id ?? name);
        if (!found) {
            if (!creationSettled) throw new BrowserContainerCleanupError(name);
            return;
        }
        const response = await call("DELETE", `/containers/${found}?force=1&v=1`);
        if (![204, 404].includes(response.status))
            throw new BrowserContainerCleanupError(name);
        if (await inspect(found)) throw new BrowserContainerCleanupError(name);
    };
    const close = () => {
        stopped = true;
        controller.abort();
        signal.removeEventListener("abort", onAbort);
        closing ??= (async () => {
            // A pending create/start must settle before absence can prove cleanup.
            await active.catch(() => {});
            try {
                await remove();
            } catch {
                throw new BrowserContainerCleanupError(name);
            }
        })();
        return closing;
    };
    const onAbort = () => {
        void close().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const create = async () => {
        signal.throwIfAborted();
        creationIssued = true;
        const response = await call(
            "POST",
            `/containers/create?name=${name}`,
            browserContainerSpec(config.imageId, owner)
        );
        // Even a non-201 reply is not proof that no container was created. Inspect
        // the generated name on failure; only a completed valid response settles it.
        if (response.status !== 201) {
            // These documented rejections settle creation; a transport error or 5xx
            // can still leave an uncertain result and requires reconciliation.
            creationSettled = [400, 404, 409].includes(response.status);
            throw new Error("The browser container could not be created.");
        }
        id = v.parse(v.object({ Id: containerId }), response.body).Id;
        creationSettled = true;
        if ((await inspect(id)) !== id)
            throw new Error("The browser container disappeared during creation.");
        signal.throwIfAborted();
        if (stopped) throw new Error("The browser container is stopped.");
    };
    active = Promise.resolve().then(create);
    try {
        await active;
    } catch (error) {
        await close();
        throw error;
    }
    return {
        id: id!,
        name,
        signal: controller.signal,
        start: () => {
            if (stopped || started)
                return Promise.reject(
                    new Error("The browser container cannot be started again.")
                );
            started = true;
            active = (async () => {
                signal.throwIfAborted();
                if ((await inspect(id!)) !== id)
                    throw new Error("The browser container is no longer available.");
                signal.throwIfAborted();
                if (stopped) throw new Error("The browser container is stopped.");
                const response = await call("POST", `/containers/${id}/start`);
                if (response.status !== 204)
                    throw new Error("The browser container did not start.");
                signal.throwIfAborted();
                if (stopped) throw new Error("The browser container is stopped.");
            })();
            return active.catch(async (error: unknown) => {
                await close();
                throw error;
            });
        },
        close,
    };
}
