import { sourceVersionSchema } from "@homelab/contracts/sourceDependencies";
import * as v from "valibot";

import information from "../../../../../package.json";
import { MiraFailure } from "../data/context";

/**
 * Hash the exact upstream archive for a manifest-owned NuGet dependency without running it.
 * @param input - Manifest key and numeric version chosen for the dependency task.
 * @param signal - Lifetime of the owning tool call.
 * @returns Artifact identity and SHA-256 for the structured manifest edit.
 */
export async function readDependencyPackage(input: unknown, signal: AbortSignal) {
    const { dependency, version } = v.parse(
        v.strictObject({
            dependency: v.string(),
            version: sourceVersionSchema,
        }),
        input
    );
    const entry = Object.entries(information.config.windows).find(
        ([key]) => dependency === `windows:${key}`
    );
    const source = entry?.[1].update;
    if (!source || !("package" in source) || source.kind !== "nuget")
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose a NuGet dependency registered in the Homelab manifest."
        );
    const name = source.package;
    const url = `https://api.nuget.org/v3-flatcontainer/${name}/${version}/${name}.${version}.nupkg`;
    const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
    });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "The selected NuGet archive could not be retrieved."
        );
    }
    const hash = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    for await (const chunk of response.body) {
        if (!(chunk instanceof Uint8Array))
            throw new MiraFailure("PRECONDITION_FAILED", "Invalid archive content.");
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024 * 1024)
            throw new MiraFailure(
                "BAD_REQUEST",
                "The NuGet archive exceeds the download limit."
            );
        hash.update(chunk);
    }
    if (!bytes)
        throw new MiraFailure("PRECONDITION_FAILED", "The NuGet archive was empty.");
    return { dependency, version, url, bytes, sha256: hash.digest("hex") };
}
