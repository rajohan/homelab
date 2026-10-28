import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the companion entrypoint as a self-contained executable with ambient config loading disabled.
 * @param platform - Host Linux x64 or cross-compiled Windows x64; other targets await qualification.
 * @param outputRoot - Optional isolated build directory for qualification; never cleaned by this builder.
 * @returns The executable path; distribution remains tied to the Homelab release process.
 */
export async function buildComputer(
    platform: "linux-x64" | "windows-x64",
    outputRoot?: string
): Promise<string> {
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const directory = path.join(
        outputRoot ?? path.join(root, "apps/mira/dist/computer"),
        platform
    );
    await mkdir(directory, { recursive: true });
    const outfile = path.join(
        directory,
        platform === "windows-x64" ? "mira-computer.exe" : "mira-computer"
    );
    const build = Bun.spawn(
        [
            process.execPath,
            "build",
            "--compile",
            `--target=bun-${platform}`,
            ...(platform === "windows-x64"
                ? [
                      "--windows-icon=" +
                          path.join(root, "packages/ui/src/assets/rajohan.ico"),
                  ]
                : []),
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            "--no-compile-autoload-tsconfig",
            "--no-compile-autoload-package-json",
            `--outfile=${outfile}`,
            path.join(root, "apps/mira/src/server/computer/companionCli.ts"),
        ],
        {
            cwd: root,
            stdout: "ignore",
            stderr: "inherit",
            timeout: 120_000,
            windowsHide: true,
        }
    );
    if ((await build.exited) !== 0) throw new Error("Computer companion build failed.");
    return outfile;
}

if (import.meta.main) {
    const [platform, ...extra] = process.argv.slice(2);
    if (extra.length > 0 || (platform !== "linux-x64" && platform !== "windows-x64"))
        throw new Error("Usage: bun run build:computer <linux-x64|windows-x64>");
    console.info(await buildComputer(platform));
}
