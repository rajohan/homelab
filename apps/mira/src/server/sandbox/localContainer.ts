import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";

import * as v from "valibot";

import { attachBrowserContainer, browserDockerFrames } from "../browsing/attach";
import { browserDockerRequest, type BrowserDockerRequest } from "../browsing/docker";
import { browserEgressSchema, verifyBrowserEgress } from "../browsing/egress";
import {
    parseLocalCheckInput,
    parseLocalCheckResult,
    type LocalCheckResult,
} from "./localProtocol";

const image = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
const id = v.pipe(v.string(), v.uuid());
const containerId = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const label = "io.homelab.mira.code-owner";
export const localCodeConfigurationSchema = v.strictObject({
    socketPath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    imageId: image,
    egress: v.optional(browserEgressSchema),
});
type Configuration = v.InferOutput<typeof localCodeConfigurationSchema>;

/** Durable callbacks supplied by the trusted queue owner, never the model or sandbox. */
export interface LocalCodeJournal {
    /** Persist creation intent and verify current authority before Docker is contacted. */
    creating: () => Promise<void>;
    /** Persist the immutable container receipt before it can start. */
    created: (containerId: string) => Promise<void>;
    /** Record a settled Engine rejection, permitting recovery to prove non-creation. */
    rejected: () => Promise<void>;
    /** Recheck current ownership, cancellation and approval immediately before startup. */
    starting: () => Promise<void>;
    /** Revoke execution and record cleanup intent, even when the command failed. */
    cleaning: () => Promise<void>;
    /** Record an ownership-verified discovery before removal makes it unobservable. */
    discovered: (containerId: string) => Promise<void>;
    /** Release capacity only after confirmed absence or settled non-creation. */
    cleaned: () => Promise<void>;
}

/**
 * Specify an unprivileged local container for the existing ten-minute fixed check profile.
 * @param configuration - Trusted immutable image and optional dedicated public-egress slot.
 * @param owner - Durable attempt UUID, used for ownership and never reused for another attempt.
 * @returns A fixed entry point, no host mounts or ports, and bounded CPU, memory, disk and processes.
 */
export function localCodeContainerSpec(configuration: Configuration, owner: string) {
    const config = v.parse(localCodeConfigurationSchema, configuration);
    v.parse(id, owner);
    return {
        Image: config.imageId,
        User: "postgres",
        WorkingDir: "/tmp",
        Entrypoint: ["/usr/bin/timeout"],
        Cmd: [
            "--signal=KILL",
            "660s",
            "bun",
            "--no-env-file",
            "/opt/homelab/local-check.js",
        ],
        Labels: { [label]: owner },
        OpenStdin: true,
        StdinOnce: true,
        Tty: false,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: false,
        NetworkDisabled: !config.egress,
        ...(config.egress ? { Env: ["HOMELAB_MIRA_LOCAL_EGRESS=public"] } : {}),
        HostConfig: {
            AutoRemove: false,
            Init: true,
            NetworkMode: config.egress?.networkId ?? "none",
            ...(config.egress ? { Dns: ["127.0.0.1"] } : {}),
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            Memory: 8 * 1024 ** 3,
            MemorySwap: 8 * 1024 ** 3,
            NanoCpus: 4_000_000_000,
            PidsLimit: 1024,
            Tmpfs: {
                "/tmp": "rw,nosuid,nodev,exec,size=2147483648,mode=1777",
                // Override the PostgreSQL base image's implicit persistent volume.
                "/var/lib/postgresql": "rw,nosuid,nodev,noexec,size=1m,mode=0700",
            },
            LogConfig: { Type: "none", Config: {} },
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Binds: [],
            PortBindings: {},
        },
    };
}

async function engine(value: unknown, request?: BrowserDockerRequest) {
    const config = v.parse(localCodeConfigurationSchema, value);
    const metadata = path.isAbsolute(config.socketPath)
        ? await lstat(config.socketPath)
        : null;
    if (
        !path.isAbsolute(config.socketPath) ||
        !metadata?.isSocket() ||
        (await realpath(config.socketPath)) !== config.socketPath
    )
        throw new Error("Local code checks require a canonical local Docker socket.");
    const call = request ?? browserDockerRequest(config.socketPath);
    return { config, call };
}

async function inspect(
    call: BrowserDockerRequest,
    config: Configuration,
    owner: string,
    reference: string
) {
    const reply = await call("GET", `/containers/${reference}/json`);
    if (reply.status === 404) return null;
    if (reply.status !== 200) throw new Error("Local code container inspection failed.");
    const found = v.parse(
        v.object({
            Id: containerId,
            Image: image,
            Config: v.object({ Labels: v.record(v.string(), v.string()) }),
        }),
        reply.body
    );
    if (
        found.Image !== config.imageId ||
        found.Config.Labels[label] !== owner ||
        (reference !== `mira-code-${owner}` && found.Id !== reference)
    )
        throw new Error("Local code container ownership changed.");
    return found.Id;
}

/**
 * Reconcile one original local attempt without starting or replaying its check.
 * @param configuration - Original immutable image and canonical local socket.
 * @param record - Persisted attempt identity and optional creation receipt or settled rejection.
 * @param journal - Durable cleanup records; database errors never prevent ownership-verified removal.
 * @param transport - Synthetic Engine boundary for tests only.
 * @returns Confirmed removal; an uncertain create with no visible receipt retains capacity.
 */
export async function cleanupLocalCodeContainer(
    configuration: unknown,
    record: { id: string; containerId?: string | undefined; settled: boolean },
    journal: Pick<LocalCodeJournal, "cleaning" | "discovered" | "cleaned">,
    transport?: BrowserDockerRequest
): Promise<void> {
    const { config, call } = await engine(configuration, transport);
    v.parse(id, record.id);
    if (record.containerId) v.parse(containerId, record.containerId);
    let journalFailed = false;
    try {
        await journal.cleaning();
    } catch {
        journalFailed = true;
    }
    const found = await inspect(
        call,
        config,
        record.id,
        record.containerId ?? `mira-code-${record.id}`
    );
    if (found) {
        try {
            await journal.discovered(found);
        } catch {
            journalFailed = true;
        }
        const removed = await call("DELETE", `/containers/${found}?force=1&v=1`);
        if (
            ![204, 404].includes(removed.status) ||
            (await inspect(call, config, record.id, found))
        )
            throw new Error("Local code cleanup is not confirmed.");
    } else if (!record.containerId && !record.settled)
        throw new Error(
            "Local code creation is uncertain; recovery must retain capacity."
        );
    if (journalFailed) throw new Error("Local code cleanup could not be recorded.");
    await journal.cleaned();
}

/**
 * Execute one fixed-profile check over private Docker stdio and confirm cleanup before returning.
 * @param configuration - Trusted local Engine and immutable qualified check image.
 * @param value - Public source selection and at most one reviewed input, never an arbitrary host command.
 * @param journal - Durable attempt fence; production callers must persist every lifecycle transition.
 * @param stopping - Permanent caller cancellation, including lost queue leases and service shutdown.
 * @param dependencies - Synthetic transport/attachment boundaries for isolated tests only.
 * @returns Untrusted passive output after container removal; failures never replay the operation.
 */
export async function executeLocalCodeCheck(
    configuration: unknown,
    value: unknown,
    journal: LocalCodeJournal,
    stopping: AbortSignal,
    dependencies: {
        request?: BrowserDockerRequest;
        attach?: typeof attachBrowserContainer;
    } = {}
): Promise<LocalCheckResult> {
    const input = parseLocalCheckInput(value);
    stopping.throwIfAborted();
    const { config, call } = await engine(configuration, dependencies.request);
    const controller = new AbortController();
    const signal = AbortSignal.any([
        stopping,
        controller.signal,
        AbortSignal.timeout(650_000),
    ]);
    const name = `mira-code-${input.request.id}`;
    let created: string | undefined;
    let issued = false,
        settled = false;
    let stream: Duplex | undefined;
    let monitoring: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    const verify = () =>
        config.egress
            ? verifyBrowserEgress(call, config.egress, created)
            : Promise.resolve();
    try {
        await verify();
        signal.throwIfAborted();
        await journal.creating();
        issued = true;
        const reply = await call(
            "POST",
            `/containers/create?name=${name}`,
            localCodeContainerSpec(config, input.request.id)
        );
        if (reply.status !== 201) {
            settled = [400, 404, 409].includes(reply.status);
            if (settled) await journal.rejected();
            throw new Error("Local code container creation failed.");
        }
        created = v.parse(v.object({ Id: containerId }), reply.body).Id;
        settled = true;
        await journal.created(created);
        if ((await inspect(call, config, input.request.id, created)) !== created)
            throw new Error("Local container disappeared.");
        signal.throwIfAborted();
        stream = await (dependencies.attach ?? attachBrowserContainer)(
            config.socketPath,
            created,
            signal
        );
        const channel = stream;
        const result = new Promise<LocalCheckResult>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            const fail = () =>
                reject(new Error("Local check output was interrupted or invalid."));
            const receive = browserDockerFrames((chunk) => {
                bytes += chunk.length;
                if (bytes > 24 * 1_048_576 + 16_384) throw new Error("Oversized output.");
                chunks.push(chunk);
                if (!chunk.includes(10)) return;
                resolve(
                    parseLocalCheckResult(
                        JSON.parse(Buffer.concat(chunks).toString("utf8")),
                        input.request
                    )
                );
            });
            channel.on("data", (chunk: Buffer) => {
                try {
                    receive(chunk);
                } catch {
                    fail();
                    controller.abort();
                }
            });
            channel.once("error", fail);
            channel.once("end", fail);
            channel.once("close", fail);
            signal.addEventListener("abort", fail, { once: true });
            if (signal.aborted) fail();
        });
        // A failed startup still has an attached promise; observe it before awaiting I/O.
        void result.catch(() => {});
        await journal.starting();
        signal.throwIfAborted();
        const started = await call("POST", `/containers/${created}/start`);
        if (started.status !== 204)
            throw new Error("Local code container startup failed.");
        await verify();
        monitoring = setInterval(() => {
            if (checking || signal.aborted) return;
            checking = true;
            void verify()
                .catch(() => controller.abort())
                .finally(() => {
                    checking = false;
                });
        }, 2000);
        monitoring.unref();
        signal.throwIfAborted();
        channel.write(JSON.stringify(input) + "\n", (error) => {
            if (error) controller.abort();
        });
        const output = await result;
        signal.throwIfAborted();
        return output;
    } finally {
        clearInterval(monitoring);
        controller.abort();
        stream?.destroy();
        if (issued)
            await cleanupLocalCodeContainer(
                config,
                { id: input.request.id, containerId: created, settled },
                journal,
                call
            );
    }
}
