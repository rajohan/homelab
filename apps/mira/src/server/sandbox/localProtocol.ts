import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";
import * as v from "valibot";

import {
    daytonaCheckProfile,
    daytonaSandboxSchema,
    parseDaytonaArguments,
    daytonaCheckContent,
    daytonaEditContent,
    daytonaSourceContent,
} from "./profile";

const text = v.pipe(
    v.string(),
    v.check((value) => value.isWellFormed() && Buffer.byteLength(value) <= 1_048_576)
);
export const localCheckInputSchema = v.strictObject({
    request: daytonaSandboxSchema,
    input: v.nullable(text),
});
export type LocalCheckInput = v.InferOutput<typeof localCheckInputSchema>;
export const localCheckResultSchema = v.strictObject({
    exitCode: v.picklist([0, 1]),
    files: v.pipe(
        v.array(
            v.strictObject({
                name: v.picklist([
                    "check-result.json",
                    "check-log.txt",
                    "changes.txt",
                    "source-files.json",
                    "source-tree.json",
                ]),
                text,
            })
        ),
        v.minLength(3),
        v.maxLength(4),
        v.check((files) => new Set(files.map((file) => file.name)).size === files.length)
    ),
});
export type LocalCheckResult = v.InferOutput<typeof localCheckResultSchema>;

/**
 * Recover only canonical fixed-profile proposals from the shared code-job queue.
 * @param id - Durable job identity, which must match the command's request ID.
 * @param content - Reviewed command and exact input/output selection; never executed as shell text.
 * @returns Structured request after reconstructing and comparing the complete transfer contract.
 */
export function localCodeRequest(id: string, content: MiraDaytonaContent) {
    const prefix = `bun --no-env-file ${daytonaCheckProfile.executable} `;
    if (!content.command.startsWith(prefix))
        throw new Error("Main accepts only the fixed Homelab code profile.");
    const args =
        content.command
            .slice(prefix.length)
            .match(/'[^']*'|[^ ]+/g)
            ?.map((part) =>
                part.startsWith("'") && part.endsWith("'") ? part.slice(1, -1) : part
            ) ?? [];
    const request = parseDaytonaArguments(args);
    if (request.id !== id) throw new Error("The code request belongs to another job.");
    const file = content.inputs[0];
    let expected: MiraDaytonaContent;
    if ("paths" in request) expected = daytonaSourceContent(request);
    else if ("editsSha256" in request) {
        if (!file) throw new Error("Choose the reviewed edit file.");
        expected = daytonaEditContent(request, file);
    } else expected = daytonaCheckContent(request, file);
    if (
        content.command !== expected.command ||
        JSON.stringify(content.inputs) !== JSON.stringify(expected.inputs) ||
        JSON.stringify(content.outputs) !== JSON.stringify(expected.outputs)
    )
        throw new Error("The local code command or file selection changed.");
    return request;
}

/**
 * Validate one exact fixed-profile request before any local resource is allocated.
 * @param value - Selected public source and optional reviewed UTF-8 patch or edit plan.
 * @returns Validated bytes and request; missing, extra or mismatched inputs fail closed.
 */
export function parseLocalCheckInput(value: unknown): LocalCheckInput {
    const input = v.parse(localCheckInputSchema, value);
    let expected: string | null = null;
    if ("editsSha256" in input.request) expected = input.request.editsSha256;
    else if ("patchSha256" in input.request) expected = input.request.patchSha256;
    if (
        (expected === null) !== (input.input === null) ||
        (expected !== null &&
            new Bun.CryptoHasher("sha256").update(input.input!).digest("hex") !==
                expected)
    )
        throw new Error("The local check input does not match its selected digest.");
    return input;
}

/**
 * Accept only the selected profile's bounded passive result files.
 * @param value - Untrusted output from the disposable container.
 * @param request - Original validated request, never supplied by the result.
 * @returns Bounded output for subsequent owned attachment storage, not execution authority.
 */
export function parseLocalCheckResult(
    value: unknown,
    request: LocalCheckInput["request"]
): LocalCheckResult {
    const result = v.parse(localCheckResultSchema, value);
    const expected =
        "paths" in request
            ? daytonaCheckProfile.sourceOutputs
            : daytonaCheckProfile.outputs;
    if (
        JSON.stringify(result.files.map((file) => file.name).toSorted()) !==
        JSON.stringify([...expected].toSorted())
    )
        throw new Error("The local check did not return its selected result files.");
    return result;
}
