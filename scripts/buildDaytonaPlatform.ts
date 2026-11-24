import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Bundle only the public check entrypoint, its profile and the pinned Linux Bun integrity.
 * @param root - Checkout containing the reviewed sources and lockfile.
 * @returns Standalone bootstrap source, fingerprinted by both the dashboard and executor.
 */
export async function daytonaPlatformBuild(root: string): Promise<string> {
    const result = await Bun.build({
        entrypoints: [path.join(root, "apps/mira/src/server/sandbox/harness.ts")],
        target: "bun",
        minify: true,
        metafile: true,
        env: "disable",
        sourcemap: "none",
    });
    if (!result.success || result.outputs.length !== 1 || !result.metafile)
        throw new Error("Could not package the public Daytona check harness.");
    const manifest = path.join(root, "package.json");
    if (
        Object.keys(result.metafile.inputs).some(
            (input) => path.resolve(input) === manifest
        )
    )
        throw new Error(
            "The Daytona check harness must be independent of the dashboard release manifest."
        );
    const harness = await result.outputs[0]!.arrayBuffer();
    if (!harness.byteLength || harness.byteLength > 512 * 1024)
        throw new Error("Daytona check harness exceeded its release bound.");
    const lock = Bun.JSONC.parse(await readFile(path.join(root, "bun.lock"), "utf8"));
    const versionFile = await readFile(path.join(root, ".bun-version"), "utf8");
    const version = versionFile.trim();
    if (
        typeof lock !== "object" ||
        !lock ||
        !("packages" in lock) ||
        typeof lock.packages !== "object" ||
        !lock.packages
    )
        throw new Error("Invalid Bun lockfile.");
    const pkg = Object.values(lock.packages).find(
        (entry): entry is [string, string, object, string] =>
            Array.isArray(entry) &&
            entry[0] === `@oven/bun-linux-x64@${version}` &&
            typeof entry[3] === "string" &&
            /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry[3])
    );
    if (!pkg) throw new Error("Missing pinned Linux Bun integrity in bun.lock.");
    const program = await readFile(
        path.join(root, "apps/mira/src/server/integrations/daytona/platformBootstrap.py"),
        "utf8"
    );
    const gzip = Buffer.from(Bun.gzipSync(harness));
    // Preserve the qualified archive's OS metadata on every build host (RFC 1952).
    gzip[9] = 10;
    const encoded = gzip.toString("base64");
    const payload = JSON.stringify([version, pkg[3].slice("sha512-".length), encoded]);
    return program.replace(
        '"__HOMELAB_RELEASE_PAYLOAD__"',
        JSON.stringify(Buffer.from(payload).toString("base64"))
    );
}
