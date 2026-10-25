import {
    FileSystemApiAxiosParamCreator,
    ProcessApiAxiosParamCreator,
} from "@daytona/toolbox-api-client";
import { version as toolboxVersion } from "@daytona/toolbox-api-client/package.json";
import * as v from "valibot";

import { integrationBytes, integrationJson } from "../http";
import type { DaytonaConfiguration } from "./configuration";
import { DaytonaClient, type DaytonaReference } from "./controlPlane";

const processApi = ProcessApiAxiosParamCreator();
const filesApi = FileSystemApiAxiosParamCreator();
const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/));
const exitCode = v.nullish(
    v.pipe(v.number(), v.integer(), v.minValue(-255), v.maxValue(255))
);
const commandSchema = v.object({
    id: identifier,
    command: v.pipe(v.string(), v.maxLength(16_384)),
    exitCode,
});
const sessionSchema = v.object({
    sessionId: identifier,
    commands: v.pipe(v.array(commandSchema), v.maxLength(1)),
});
const text = v.pipe(v.string(), v.maxLength(65_536));
const logsSchema = v.object({
    stdout: v.optional(text),
    stderr: v.optional(text),
    output: v.optional(text),
});
type Arguments = Awaited<ReturnType<typeof processApi.getSession>>;
type Reference = Required<DaytonaReference>;
type Phase = "session" | "command" | "upload";
export interface DaytonaCommandObservation {
    state: "absent" | "empty" | "running" | "completed";
    commandId: string | null;
    exitCode: number | null;
}

/**
 * Fingerprint the exact command that a durable caller has approved, without normalizing shell syntax.
 * @param command - Explicit sandbox command, never a host command or credential-bearing shell wrapper.
 * @returns SHA-256 digest of valid, bounded UTF-8 command bytes.
 */
export function daytonaCommandHash(command: string): string {
    if (
        !command.isWellFormed() ||
        !command.trim() ||
        command.includes("\0") ||
        Buffer.byteLength(command, "utf8") > 16_384
    )
        throw new Error("Invalid Daytona command.");
    return new Bun.CryptoHasher("sha256").update(command).digest("hex");
}

/** Unknown external write outcome. The durable caller must reconcile or destroy this attempt, never replay it. */
export class DaytonaToolboxUncertain extends Error {
    readonly phase: Phase;
    readonly reference: Reference;
    /**
     * Retain the persisted attempt identity without command, file content or provider diagnostics.
     * @param phase - External mutation that may have been accepted.
     * @param reference - Already recorded sandbox and attempt identifiers.
     */
    constructor(phase: Phase, reference: Reference) {
        super(
            "Daytona did not confirm this operation. Inspect or clean up the existing attempt; do not repeat it automatically."
        );
        this.name = "DaytonaToolboxUncertain";
        this.phase = phase;
        this.reference = { ...reference };
    }
}

/** A confirmed pre-dispatch refusal because the required execution budget no longer fits. */
export class DaytonaToolboxLifetimeError extends Error {
    /**
     * Describe a known no-write result using only the configured time budget.
     * @param minimumMs - Validated minimum remaining runtime and collection allowance.
     */
    constructor(minimumMs: number) {
        super(
            `Daytona sandbox has less than ${minimumMs / 1000} seconds remaining; no write was dispatched.`
        );
        this.name = "DaytonaToolboxLifetimeError";
    }
}

/** Bounded Daytona Cloud toolbox operations for one existing, persisted sandbox attempt. No host filesystem access. */
export class DaytonaToolbox {
    private readonly configuration: DaytonaConfiguration;
    private readonly reference: Reference;
    private readonly control: DaytonaClient;
    private readonly request: typeof fetch;
    private readonly sessionId: string;
    private readonly now: () => number;
    /**
     * Bind the toolbox to a previously created sandbox; constructing this adapter performs no network request.
     * @param configuration - Explicit qualified account and immutable snapshot binding.
     * @param reference - Persisted unique attempt and exact provider sandbox UUID.
     * @param request - Injectable transport for synthetic qualification only.
     * @param now - Wall-clock milliseconds; substitute only for deterministic lifetime qualification.
     */
    constructor(
        configuration: DaytonaConfiguration,
        reference: Reference,
        request: typeof fetch = fetch,
        now: () => number = Date.now
    ) {
        const uuid = v.pipe(v.string(), v.uuid());
        if (
            !v.safeParse(uuid, reference.runId).success ||
            !v.safeParse(uuid, reference.sandboxId).success
        )
            throw new Error("Invalid Daytona attempt.");
        this.configuration = { ...configuration };
        this.reference = { ...reference };
        this.control = new DaytonaClient(configuration, request);
        this.request = request;
        this.now = now;
        this.sessionId = `mira-${reference.runId}`;
    }

    private async ready(signal: AbortSignal, writing = false): Promise<number> {
        signal.throwIfAborted();
        if (writing) await this.control.preflight(signal, true);
        const observed = await this.control.inspect(this.reference, signal);
        if (
            !observed ||
            observed.state !== "started" ||
            !observed.settingsMatch ||
            !observed.expiresAt ||
            Date.parse(observed.expiresAt) - this.now() < (writing ? 30_000 : 0)
        )
            throw new Error(
                "Daytona sandbox is not available with the required settings."
            );
        return Date.parse(observed.expiresAt);
    }

    private requireLifetime(expiresAt: number, minimumMs = 30_000): void {
        if (expiresAt - this.now() < minimumMs)
            throw new DaytonaToolboxLifetimeError(minimumMs);
    }

    private async response(args: Arguments, signal: AbortSignal): Promise<Response> {
        signal.throwIfAborted();
        const method = args.options.method?.toUpperCase();
        const route = new URL(args.url, "https://proxy.app.daytona.io");
        if (
            route.origin !== "https://proxy.app.daytona.io" ||
            route.hash ||
            !/^\/(?:process\/session(?:\/[a-zA-Z0-9_-]+(?:\/exec|\/command\/[a-zA-Z0-9_-]+\/logs)?)?|files\/(?:upload-v2|download))$/.test(
                route.pathname
            ) ||
            !method ||
            !["GET", "POST"].includes(method)
        )
            throw new Error("Invalid Daytona toolbox request.");
        const data: unknown = args.options.data;
        if (data !== undefined && typeof data !== "string" && !(data instanceof FormData))
            throw new Error("Invalid Daytona toolbox payload.");
        const body = data;
        return this.request(
            `https://proxy.app.daytona.io/toolbox/${this.reference.sandboxId}${args.url}`,
            {
                method,
                headers: {
                    Authorization: `Bearer ${this.configuration.apiKey}`,
                    "X-Daytona-Organization-ID": this.configuration.organizationId,
                    "X-Daytona-Source": "homelab-mira",
                    "X-Daytona-SDK-Version": toolboxVersion,
                    Accept: "application/json,application/octet-stream",
                    ...(body instanceof FormData
                        ? {}
                        : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body }),
                credentials: "omit",
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            }
        );
    }

    private async json(
        args: Arguments,
        signal: AbortSignal,
        missing = false
    ): Promise<unknown> {
        try {
            const response = await this.response(args, signal);
            if (missing && response.status === 404) {
                await response.body?.cancel();
                return null;
            }
            return await integrationJson(response, 256 * 1024);
        } catch {
            signal.throwIfAborted();
            throw new Error(
                "Daytona toolbox request failed or exceeded its response limit."
            );
        }
    }

    private async session(signal: AbortSignal) {
        const value = await this.json(
            await processApi.getSession(this.sessionId),
            signal,
            true
        );
        if (value === null) return null;
        const parsed = v.safeParse(sessionSchema, value);
        if (!parsed.success || parsed.output.sessionId !== this.sessionId)
            throw new Error("Daytona did not confirm this session.");
        return parsed.output;
    }

    private path(name: string, area: "inputs" | "outputs"): string {
        if (
            name.length > 512 ||
            !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) ||
            name.split("/").some((part) => part === "." || part === "..")
        )
            throw new Error("Invalid Daytona file name.");
        return `/tmp/homelab-mira/${this.reference.runId}/${area}/${name}`;
    }

    /**
     * Create the deterministic session once after the durable caller records its attempt.
     * @param signal - Shutdown or run cancellation covering the request and response.
     * @param authorize - Atomically recheck consent, lease, limits and the session-attempt claim immediately before dispatch.
     * @returns Acknowledgement only, not permission to resend an uncertain request.
     */
    async open(signal: AbortSignal, authorize: () => Promise<void>): Promise<void> {
        const expiresAt = await this.ready(signal, true);
        const args = await processApi.createSession({ sessionId: this.sessionId });
        await authorize();
        signal.throwIfAborted();
        this.requireLifetime(expiresAt);
        try {
            const response = await this.response(args, signal);
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error("Session creation was not confirmed.");
            }
            await response.body?.cancel();
        } catch {
            throw new DaytonaToolboxUncertain("session", this.reference);
        }
    }

    /**
     * Upload only explicitly supplied input bytes before command dispatch; this never opens host paths.
     * @param name - Relative name inside this attempt's inputs directory.
     * @param bytes - Already approved bytes, copied before asynchronous work and capped at 1 MiB.
     * @param signal - Run cancellation.
     * @param authorize - Durable per-file attempt/consent check; an unknown upload must not be replayed automatically.
     * @returns The fixed sandbox input path after the provider acknowledges that exact destination.
     */
    async upload(
        name: string,
        bytes: Uint8Array,
        signal: AbortSignal,
        authorize: () => Promise<void>
    ): Promise<string> {
        const path = this.path(name, "inputs");
        if (bytes.byteLength > 1024 * 1024)
            throw new Error("Daytona input exceeds 1 MiB.");
        const input = new Uint8Array(bytes);
        const expiresAt = await this.ready(signal, true);
        const session = await this.session(signal);
        if (session && session.commands.length > 0)
            throw new Error("Daytona inputs cannot change after a command has started.");
        const args = await filesApi.uploadFile(
            path,
            new File([input], "input", { type: "application/octet-stream" })
        );
        await authorize();
        signal.throwIfAborted();
        this.requireLifetime(expiresAt);
        try {
            const value = await integrationJson(await this.response(args, signal), 4096);
            const parsed = v.safeParse(v.object({ path: v.literal(path) }), value);
            if (!parsed.success) throw new Error("Upload destination was not confirmed.");
            return path;
        } catch {
            throw new DaytonaToolboxUncertain("upload", this.reference);
        }
    }

    /**
     * Submit one approved asynchronous command into an acknowledged, empty session.
     * @param command - Exact approved command; never interpolated into a host shell.
     * @param signal - Run cancellation; cancellation after dispatch does not prove the process stopped.
     * @param authorize - Persist the unique command attempt and recheck consent/lease/limits before POST.
     * @param lifetime - Optional minimum remaining budget and persisted local deadline, rechecked after authorization.
     * @returns Provider command ID to persist before polling. No automatic command retry is performed.
     */
    async submit(
        command: string,
        signal: AbortSignal,
        authorize: () => Promise<void>,
        lifetime?: { minimumMs: number; deadline: number }
    ): Promise<string> {
        daytonaCommandHash(command);
        const minimumMs = lifetime?.minimumMs ?? 30_000;
        if (
            !Number.isSafeInteger(minimumMs) ||
            minimumMs < 30_000 ||
            minimumMs > 900_000 ||
            (lifetime &&
                (!Number.isSafeInteger(lifetime.deadline) || lifetime.deadline < 0))
        )
            throw new Error("Invalid Daytona command lifetime budget.");
        const expiresAt = Math.min(
            await this.ready(signal, true),
            lifetime?.deadline ?? Infinity
        );
        this.requireLifetime(expiresAt, minimumMs);
        const session = await this.session(signal);
        if (!session || session.commands.length > 0)
            throw new Error("Daytona requires an acknowledged empty session.");
        const args = await processApi.sessionExecuteCommand(this.sessionId, {
            command,
            runAsync: true,
            suppressInputEcho: true,
        });
        await authorize();
        signal.throwIfAborted();
        this.requireLifetime(expiresAt, minimumMs);
        try {
            const parsed = v.safeParse(
                v.object({ cmdId: identifier }),
                await this.json(args, signal)
            );
            if (!parsed.success) throw new Error("Command receipt was not confirmed.");
            return parsed.output.cmdId;
        } catch {
            throw new DaytonaToolboxUncertain("command", this.reference);
        }
    }

    /**
     * Recover command identity and completion without executing or replaying anything.
     * @param commandHash - Persisted hash of the exact approved command.
     * @param signal - Read cancellation.
     * @param commandId - Persisted provider ID when acknowledged; must match the recovered command.
     * @returns Explicit absent/empty/running/completed observation. Absence never authorizes a retry.
     */
    async inspect(
        commandHash: string,
        signal: AbortSignal,
        commandId?: string
    ): Promise<DaytonaCommandObservation> {
        if (
            !/^[a-f0-9]{64}$/.test(commandHash) ||
            (commandId !== undefined && !v.safeParse(identifier, commandId).success)
        )
            throw new Error("Invalid Daytona command reference.");
        await this.ready(signal);
        const session = await this.session(signal);
        const command = session?.commands[0];
        if (!command)
            return {
                state: session ? "empty" : "absent",
                commandId: null,
                exitCode: null,
            };
        if (
            daytonaCommandHash(command.command) !== commandHash ||
            (commandId !== undefined && command.id !== commandId)
        )
            throw new Error("Daytona did not confirm the approved command.");
        return {
            state:
                command.exitCode === null || command.exitCode === undefined
                    ? "running"
                    : "completed",
            commandId: command.id,
            exitCode: command.exitCode ?? null,
        };
    }

    /**
     * Read a bounded log snapshot for an identity-checked command without a following socket.
     * @param commandHash - Exact approved command fingerprint.
     * @param commandId - Previously persisted provider command ID.
     * @param signal - Read cancellation; oversized snapshots fail explicitly rather than implying complete logs.
     * @returns Untrusted plain text stdout/stderr/combined fields, never HTML or executable content.
     */
    async logs(
        commandHash: string,
        commandId: string,
        signal: AbortSignal
    ): Promise<{ stdout: string; stderr: string; output: string }> {
        const observed = await this.inspect(commandHash, signal, commandId);
        if (observed.commandId !== commandId)
            throw new Error("Daytona command logs are not available.");
        const value = await this.json(
            await processApi.getSessionCommandLogs(this.sessionId, commandId, false),
            signal
        );
        const parsed = v.safeParse(logsSchema, value);
        if (
            !parsed.success ||
            Object.values(parsed.output).every((part) => part === undefined)
        )
            throw new Error("Daytona returned invalid command logs.");
        const { stdout = "", stderr = "", output = "" } = parsed.output;
        if (Buffer.byteLength(stdout + stderr + output, "utf8") > 128 * 1024)
            throw new Error("Daytona command logs exceeded their response limit.");
        return { stdout, stderr, output };
    }

    /**
     * Retrieve one explicitly selected artifact as bounded bytes, without writing or extracting it on the host.
     * @param name - Relative name under this attempt's outputs directory; not an arbitrary provider URL.
     * @param signal - Read cancellation covering headers and all bytes.
     * @returns At most 1 MiB of untrusted bytes, or null when that file is absent. No local path is opened.
     */
    async download(name: string, signal: AbortSignal): Promise<Uint8Array | null> {
        const path = this.path(name, "outputs");
        await this.ready(signal);
        try {
            const response = await this.response(
                await filesApi.downloadFile(path),
                signal
            );
            if (response.status === 404) {
                await response.body?.cancel();
                return null;
            }
            return await integrationBytes(response, 1024 * 1024);
        } catch {
            signal.throwIfAborted();
            throw new Error("Daytona artifact request failed or exceeded 1 MiB.");
        }
    }
}
