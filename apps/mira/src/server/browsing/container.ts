import { randomUUID } from "node:crypto";

import * as v from "valibot";

import type { BrowserDockerRequest } from "./docker";
import { browserEgressSchema, verifyBrowserEgress, type BrowserEgress } from "./egress";
import { browserEngine } from "./engine";
import { browserProfileDirectory, type BrowserProfile } from "./profile";

const imageId = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
const containerId = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const ownerLabel = "io.homelab.mira.browser-owner";

/** Verified evidence from this controller's actual local Docker lifecycle. */
export type BrowserContainerProof =
    | { kind: "not-created" | "rejected" }
    | { kind: "removed" | "absent"; containerId: string };

/** Trusted database journal; unavailable or replaced ownership must fail closed. */
export interface BrowserContainerJournal {
    /** Durable, host-reserved UUID used for the exact Docker name and owner label. */
    owner: string;
    /** Commit create intent before any request can reach Docker. */
    creating: () => Promise<void>;
    /** Record the settled immutable ID before attachment or startup. */
    created: (id: string) => Promise<void>;
    /** Persist a settled Engine rejection so later absence can release the slot. */
    rejected: (status: 400 | 404 | 409) => Promise<void>;
    /** Persist a verified discovered ID before removal can make it unobservable. */
    discovered: (id: string) => Promise<void>;
    /** Verify current controller and human authority immediately before startup. */
    starting: () => Promise<void>;
    /** Revoke execution and obtain cleanup authority before removing the container. */
    cleaning: () => Promise<void>;
    /** Release durable capacity only after actual verified cleanup. */
    cleaned: (proof: BrowserContainerProof) => Promise<void>;
}

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
 * Build an isolated, unprivileged browser container with a daemon-enforced process boundary.
 * @param image - Already-installed immutable image ID, selected by the trusted updater/host.
 * @param owner - Unpredictable host-generated lifetime identifier.
 * @param egress - Optional trusted preprovisioned private slot; omitted means fully offline.
 * @param profile - Optional trusted registry identity for the one reserved bounded profile snapshot.
 * @returns Fixed resource limits and a hard deadline around the packaged worker entrypoint.
 */
export function browserContainerSpec(
    image: string,
    owner: string,
    egress?: BrowserEgress,
    profile?: BrowserProfile
) {
    if (egress) v.parse(browserEgressSchema, egress);
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
        NetworkDisabled: !egress,
        ...(egress || profile
            ? {
                  Env: [
                      ...(egress ? ["MIRA_BROWSER_NETWORK=public"] : []),
                      ...(profile
                          ? [
                                "MIRA_BROWSER_PROFILE=saved",
                                `CUA_DRIVER_BROWSER_PROFILE_ROOT=${browserProfileDirectory}`,
                            ]
                          : []),
                  ],
              }
            : {}),
        HostConfig: {
            AutoRemove: true,
            Init: true,
            NetworkMode: egress?.networkId ?? "none",
            // Docker retains 127.0.0.11 for local aliases on this private network;
            // this setting disables external forwarding, not alias resolution.
            ...(egress ? { Dns: ["127.0.0.1"] } : {}),
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            Memory: 1536 * 1024 * 1024,
            NanoCpus: 2_000_000_000,
            PidsLimit: 256,
            Tmpfs: {
                ...(profile
                    ? {
                          [browserProfileDirectory]:
                              "rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700",
                      }
                    : {}),
                ...(egress
                    ? {
                          "/etc/chromium/policies/managed":
                              "rw,nosuid,nodev,noexec,size=64k,uid=1000,gid=1000",
                      }
                    : {}),
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

/** Private lifecycle with an optional bounded checkpoint before destructive cleanup. */
export interface BrowserContainerLease {
    id: string;
    name: string;
    signal: AbortSignal;
    start: () => Promise<void>;
    close: () => Promise<void>;
    beforeRemoval?: (checkpoint: () => Promise<void>) => void;
}

/**
 * Create a private container lease; no browser runs before the caller explicitly starts it.
 * @param input - Trusted local Unix socket and preinstalled immutable browser image ID.
 * @param signal - Permanent host cancellation, including during creation.
 * @param transport - Synthetic replacement for lifecycle tests; never model-selected.
 * @param journal - Optional trusted durable lifecycle; its UUID is fixed before creation.
 * @returns One start-only lease. Close proves container absence or rejects permanently.
 */
export async function prepareBrowserContainer(
    input: unknown,
    signal: AbortSignal,
    transport?: BrowserDockerRequest,
    journal?: BrowserContainerJournal
): Promise<BrowserContainerLease> {
    signal.throwIfAborted();
    const engine = await browserEngine(input, transport);
    const { config, call } = engine;
    const owner = v.parse(v.pipe(v.string(), v.uuid()), journal?.owner ?? randomUUID());
    const name = `mira-browser-${owner}`;
    let id: string | undefined;
    let creationIssued = false;
    let creationSettled = false;
    let stopped = false;
    let started = false;
    let closing: Promise<void> | undefined;
    let active = Promise.resolve();
    let checking = false;
    let networkJoined = false;
    let networkTimer: ReturnType<typeof setInterval> | undefined;
    let checkpoint: (() => Promise<void>) | undefined;
    const verify = async () => {
        if (config.egress)
            await verifyBrowserEgress(
                call,
                config.egress,
                networkJoined ? id : undefined
            );
    };
    const controller = new AbortController();
    const inspect = (reference: string) => engine.inspect(reference, owner, id);
    const remove = async (): Promise<BrowserContainerProof> => {
        if (!creationIssued) return { kind: "not-created" };
        const found = await inspect(id ?? name);
        if (!found) {
            // Durable recovery cannot free an uncertain create with no returned ID.
            if (!creationSettled) throw new BrowserContainerCleanupError(name);
            return id
                ? { kind: "absent", containerId: id }
                : { kind: journal ? "rejected" : "not-created" };
        }
        await journal?.discovered(found);
        const response = await call("DELETE", `/containers/${found}?force=1&v=1`);
        if (response.status === 409) {
            // AutoRemove may already own removal after the final checkpoint.
            // A conflict is never cleanup proof; require verified absence.
            const deadline = performance.now() + 1500;
            while (performance.now() < deadline) {
                if (!(await inspect(found)))
                    return { kind: "absent", containerId: found };
                await Bun.sleep(50);
            }
        }
        if (![204, 404].includes(response.status))
            throw new BrowserContainerCleanupError(name);
        if (await inspect(found)) throw new BrowserContainerCleanupError(name);
        return { kind: "removed", containerId: found };
    };
    const close = () => {
        stopped = true;
        clearInterval(networkTimer);
        controller.abort();
        signal.removeEventListener("abort", onAbort);
        closing ??= (async () => {
            // A pending create/start must settle before absence can prove cleanup.
            await active.catch(() => {});
            try {
                await journal?.cleaning();
                // Input is already revoked. The private checkpoint has its own deadline;
                // any failure still proceeds to unconditional, ownership-verified removal.
                if (config.profile && started) await checkpoint?.().catch(() => {});
                const proof = await remove();
                await journal?.cleaned(proof);
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
        await verify();
        signal.throwIfAborted();
        await journal?.creating();
        // Once intent is committed, settle this single create even if cancellation
        // arrived during the journal write. The container stays stopped; close
        // waits for this request and removes it before releasing capacity.
        creationIssued = true;
        const response = await call(
            "POST",
            `/containers/create?name=${name}`,
            browserContainerSpec(config.imageId, owner, config.egress, config.profile)
        );
        // Even a non-201 reply is not proof that no container was created. Inspect
        // the generated name on failure; only a completed valid response settles it.
        if (response.status !== 201) {
            // These documented rejections settle creation; a transport error or 5xx
            // can still leave an uncertain result and requires reconciliation.
            creationSettled = [400, 404, 409].includes(response.status);
            if (
                response.status === 400 ||
                response.status === 404 ||
                response.status === 409
            )
                await journal?.rejected(response.status);
            throw new Error("The browser container could not be created.");
        }
        id = v.parse(v.object({ Id: containerId }), response.body).Id;
        creationSettled = true;
        await journal?.created(id);
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
        beforeRemoval: (flush: () => Promise<void>) => {
            if (started || stopped || checkpoint)
                throw new Error("Invalid browser checkpoint registration.");
            checkpoint = flush;
        },
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
                await verify();
                await journal?.starting();
                signal.throwIfAborted();
                if (stopped) throw new Error("The browser container is stopped.");
                const response = await call("POST", `/containers/${id}/start`);
                if (response.status !== 204)
                    throw new Error("The browser container did not start.");
                networkJoined = true;
                await verify();
                if (config.egress && !stopped) {
                    networkTimer = setInterval(() => {
                        if (checking || stopped) return;
                        checking = true;
                        void verify()
                            .catch(() => close())
                            .catch(() => {})
                            .finally(() => {
                                checking = false;
                            });
                    }, 2000);
                    networkTimer.unref();
                }
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
