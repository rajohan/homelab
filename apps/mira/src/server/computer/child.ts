import type { Readable, Writable } from "node:stream";

import { miraComputerElementTokenSchema } from "@homelab/contracts/miraComputerCommands";
import * as v from "valibot";

import { openNativeComputerWindow } from "./native";
import { computerDriverVersion, computerWindowGrant } from "./policy";
import type { ComputerWindowPort } from "./session";

const coordinate = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8191));
const requestSchema = v.strictObject({
    id: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(Number.MAX_SAFE_INTEGER)
    ),
    method: v.picklist(["initialize", "observe", "click", "click_element", "type"]),
    params: v.unknown(),
});

/**
 * Serve a single trusted parent over private pipes; no network listener or model-selected tools.
 * @param input - Parent-owned request pipe; EOF immediately revokes further input.
 * @param output - Bounded response pipe; errors retire the native driver.
 * @param open - Native factory, replaceable only by synthetic tests.
 * @param forceExit - Process-only fallback when native shutdown does not settle within two seconds.
 * @returns Completion after native cleanup; a production fallback terminates the whole child.
 */
export function serveComputerChild(
    input: Readable,
    output: Writable,
    open: typeof openNativeComputerWindow = openNativeComputerWindow,
    forceExit: () => void = () => {
        process.kill(process.pid, "SIGKILL");
    }
): Promise<void> {
    const controller = new AbortController();
    let buffer = Buffer.alloc(0);
    let busy = false;
    let initialized = false;
    let lastId = 0;
    let port: ComputerWindowPort | undefined;
    let active = Promise.resolve();
    let stopped = false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const lifetime = setTimeout(() => stop(), 300_000);
    let idle = setTimeout(() => stop(), 60_000);
    const stop = () => {
        if (stopped) return;
        stopped = true;
        controller.abort();
        buffer = Buffer.alloc(0);
        clearTimeout(lifetime);
        clearTimeout(idle);
        input.off("data", receive);
        const forced = setTimeout(forceExit, 2000);
        void active
            .catch(() => {})
            .then(() => port?.close())
            .catch(() => {})
            .finally(() => {
                clearTimeout(forced);
                input.off("end", stop);
                input.off("close", stop);
                input.off("error", stop);
                output.off("error", stop);
                input.destroy();
                output.end();
                finish();
            });
    };
    const handle = async (line: Buffer) => {
        const request = v.parse(requestSchema, JSON.parse(line.toString("utf8")));
        if (request.id <= lastId) throw new Error("Repeated computer request.");
        lastId = request.id;
        let result: unknown;
        if (request.method === "initialize") {
            if (initialized) throw new Error("Computer worker already initialized.");
            initialized = true;
            const grant = computerWindowGrant(request.params);
            port = await open(grant);
            result = { version: 1, driver: computerDriverVersion };
        } else {
            if (!port) throw new Error("Computer worker is not initialized.");
            controller.signal.throwIfAborted();
            switch (request.method) {
                case "observe": {
                    v.parse(v.strictObject({}), request.params);
                    result = await port.observe(controller.signal);
                    break;
                }
                case "click": {
                    const command = v.parse(
                        v.strictObject({ x: coordinate, y: coordinate }),
                        request.params
                    );
                    result = await port.click(command.x, command.y, controller.signal);
                    break;
                }
                case "click_element": {
                    const command = v.parse(
                        v.strictObject({ elementToken: miraComputerElementTokenSchema }),
                        request.params
                    );
                    result = await port.clickElement(
                        command.elementToken,
                        controller.signal
                    );
                    break;
                }
                case "type": {
                    const command = v.parse(
                        v.strictObject({
                            text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
                        }),
                        request.params
                    );
                    result = await port.type(command.text, controller.signal);
                    break;
                }
            }
        }
        controller.signal.throwIfAborted();
        const response = JSON.stringify({ id: request.id, result }) + "\n";
        if (
            Buffer.byteLength(response) > 4 * 1024 * 1024 ||
            output.writableLength > 4 * 1024 * 1024
        )
            throw new Error("Computer response exceeds its bound.");
        await new Promise<void>((resolve, reject) => {
            output.write(response, (error) => (error ? reject(error) : resolve()));
        });
    };
    const receive = (chunk: Buffer) => {
        if (stopped) return;
        // Parent requests contain only a grant or <=4096 characters, never images.
        if (busy || buffer.length + chunk.length > 32 * 1024) {
            stop();
            return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end === -1) return;
        if (end !== buffer.length - 1) {
            stop();
            return;
        }
        const line = buffer.subarray(0, end);
        buffer = Buffer.alloc(0);
        busy = true;
        clearTimeout(idle);
        active = handle(line).finally(() => {
            busy = false;
            if (!stopped) idle = setTimeout(() => stop(), 60_000);
        });
        void active.catch(stop);
    };
    input.on("data", receive);
    input.once("end", stop);
    input.once("close", stop);
    input.once("error", stop);
    output.once("error", stop);
    return done;
}

if (import.meta.main) await serveComputerChild(process.stdin, process.stdout);
