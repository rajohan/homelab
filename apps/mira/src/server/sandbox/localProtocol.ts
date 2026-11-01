import * as v from "valibot";

import { daytonaCheckProfile, daytonaSandboxSchema } from "./profile";

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
