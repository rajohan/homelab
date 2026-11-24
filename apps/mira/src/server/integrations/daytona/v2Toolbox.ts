import * as v from "valibot";

import { integrationBytes, integrationJson } from "../http";
import type { DaytonaReference } from "./controlPlane";
import { daytonaCommandHash, DaytonaToolboxLifetimeError } from "./toolbox";
import type { DaytonaV2 } from "./v2";

const processId = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,160}$/));
const recordSchema = v.object({
    id: processId,
    kind: v.literal("exec"),
    state: v.string(),
    shellCommand: v.string(),
    tag: v.string(),
    exitCode: v.nullish(v.pipe(v.number(), v.integer())),
});
const logPage = v.object({
    eof: v.boolean(),
    truncatedHead: v.boolean(),
    nextCursor: v.string(),
    frames: v.array(v.object({ channel: v.string(), data: v.string() })),
});

/** Scope v2 processes and binary transfers to a single approved sandbox attempt. */
export class DaytonaV2Toolbox {
    private readonly control: DaytonaV2;
    private readonly ref: Required<DaytonaReference>;
    private readonly request: typeof fetch;
    /** Bind the recorded provider ID without making requests.
     * @param control - v2 client carrying the exact original project binding.
     * @param ref - Durable sandbox ID and attempt ID.
     * @param request - HTTP transport to the verified regional toolbox.
     */
    constructor(
        control: DaytonaV2,
        ref: Required<DaytonaReference>,
        request: typeof fetch
    ) {
        this.control = control;
        this.ref = ref;
        this.request = request;
    }

    private async response(
        path: string,
        operation: "toolbox:exec" | "toolbox:fs",
        signal: AbortSignal,
        write?: { body: FormData | string; authorize: () => Promise<void> }
    ) {
        const access = await this.control.toolbox(this.ref, operation, signal);
        if (write) {
            await write.authorize();
            if (access.deadline <= Date.now() + 30_000)
                throw new DaytonaToolboxLifetimeError(30_000);
        }
        return this.request(access.url + path, {
            method: write ? "POST" : "GET",
            ...(write ? { body: write.body } : {}),
            headers: {
                Authorization: `Bearer ${access.token}`,
                ...(typeof write?.body === "string"
                    ? { "Content-Type": "application/json" }
                    : {}),
            },
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
    }

    private path(name: string, kind: "inputs" | "outputs") {
        if (
            name.length > 512 ||
            !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) ||
            name.split("/").some((part) => part === "." || part === "..")
        )
            throw new Error("Invalid Daytona file path.");
        return `/tmp/homelab-mira/${this.ref.runId}/${kind}/${name}`;
    }

    private async process(hash: string, id: string, signal: AbortSignal) {
        const row = v.parse(
            recordSchema,
            await integrationJson(
                await this.response(
                    `/processes/${v.parse(processId, id)}`,
                    "toolbox:exec",
                    signal
                ),
                32 * 1024
            )
        );
        if (
            row.id !== id ||
            row.tag !== this.ref.runId ||
            daytonaCommandHash(row.shellCommand) !== hash
        )
            throw new Error("Daytona process does not match the recorded command.");
        return row;
    }

    /** Verify access before the input phase. v2 runs each command as a standalone process.
     * @param signal - Cancellation covering sandbox readiness.
     * @param authorize - Persist the existing preparation checkpoint.
     */
    async open(signal: AbortSignal, authorize: () => Promise<void>) {
        await this.control.toolbox(this.ref, "toolbox:exec", signal);
        await authorize();
    }

    /** Upload the approved bytes to this job's private input directory.
     * @param name - Validated relative input path.
     * @param bytes - Bounded operator-approved file.
     * @param signal - Cancellation covering receipt.
     * @param authorize - Persist the per-file attempt before sending bytes.
     * @returns Exact destination path after provider acknowledgement.
     */
    async upload(
        name: string,
        bytes: Uint8Array,
        signal: AbortSignal,
        authorize: () => Promise<void>
    ) {
        if (bytes.byteLength > 1024 * 1024)
            throw new Error("Daytona input exceeds 1 MiB.");
        const path = this.path(name, "inputs"),
            form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)]), "input");
        const response = await this.response(
            "/files/upload?" + new URLSearchParams({ path }).toString(),
            "toolbox:fs",
            signal,
            { body: form, authorize }
        );
        await response.body?.cancel();
        if (!response.ok)
            throw new Error("Daytona did not acknowledge the uploaded file.");
        return path;
    }

    /** Submit one bounded command and record its immutable process identity.
     * @param command - Exact reviewed shell command.
     * @param signal - Cancellation for the acknowledgement.
     * @param authorize - Recheck authorization and commit the nonreplayable boundary.
     * @returns Provider process ID for subsequent status/log reads.
     */
    async submit(command: string, signal: AbortSignal, authorize: () => Promise<void>) {
        const hash = daytonaCommandHash(command);
        const body = JSON.stringify({
            kind: "exec",
            shellCommand: command,
            tag: this.ref.runId,
            timeoutMs: 600_000,
        });
        const record = v.parse(
            recordSchema,
            await integrationJson(
                await this.response("/processes", "toolbox:exec", signal, {
                    body,
                    authorize,
                }),
                32 * 1024
            )
        );
        if (
            record.tag !== this.ref.runId ||
            daytonaCommandHash(record.shellCommand) !== hash
        )
            throw new Error("Unexpected Daytona process receipt.");
        return record.id;
    }

    /** Read the recorded process without starting another command.
     * @param hash - Expected command fingerprint.
     * @param signal - Cancellation for status lookup.
     * @param id - Recorded v2 process identity.
     * @returns Running/completed status and verified exit code.
     */
    async inspect(hash: string, signal: AbortSignal, id: string) {
        const p = await this.process(hash, id, signal);
        if (p.state === "terminal" && typeof p.exitCode === "number")
            return { state: "completed" as const, exitCode: p.exitCode };
        if (["running", "starting", "provisioning"].includes(p.state))
            return { state: "running" as const, exitCode: null };
        throw new Error("Unexpected Daytona process state.");
    }

    /** Read bounded stdout and stderr in the provider's recorded order.
     * @param hash - Exact approved command fingerprint.
     * @param id - Recorded provider process ID.
     * @param signal - Cancellation applying to every page.
     * @returns Recorded logs or a failure when their completeness cannot be established.
     */
    async logs(hash: string, id: string, signal: AbortSignal) {
        const p = await this.process(hash, id, signal);
        let stdout = "",
            stderr = "",
            output = "",
            cursor = "";
        for (let page = 0; page < 8; page++) {
            const query = new URLSearchParams({
                encoding: "text",
                limit: "1000",
                ...(cursor ? { cursor } : {}),
            });
            const data = v.parse(
                logPage,
                await integrationJson(
                    await this.response(
                        `/processes/${p.id}/logs?${query.toString()}`,
                        "toolbox:exec",
                        signal
                    ),
                    256 * 1024
                )
            );
            if (data.truncatedHead) throw new Error("Daytona logs are incomplete.");
            for (const frame of data.frames) {
                if (frame.channel === "stdout") stdout += frame.data;
                else if (frame.channel === "stderr") stderr += frame.data;
                output += frame.data;
            }
            if (Buffer.byteLength(stdout + stderr + output) > 128 * 1024)
                throw new Error("Daytona logs exceed their limit.");
            if (data.eof || (p.state !== "terminal" && data.frames.length < 1000))
                return { stdout, stderr, output };
            if (!data.nextCursor || data.nextCursor === cursor) break;
            cursor = data.nextCursor;
        }
        throw new Error("Daytona logs are incomplete.");
    }

    /** Download one selected output with the existing per-artifact size limit.
     * @param name - Approved relative output name.
     * @param signal - Cancellation covering all received bytes.
     * @returns Output data, or null if the file is absent.
     */
    async download(name: string, signal: AbortSignal) {
        const response = await this.response(
            "/files/download?" +
                new URLSearchParams({ path: this.path(name, "outputs") }).toString(),
            "toolbox:fs",
            signal
        );
        if (response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        return integrationBytes(response, 1024 * 1024);
    }
}
