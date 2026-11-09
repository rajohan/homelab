import { constants } from "node:fs";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Install the immutable native Bun package into an explicit caller-owned directory.
 * @param destination - Absolute directory for the new bin/bun executable.
 * @returns Completion after the installed executable matches the repository revision.
 */
export async function installBun(destination: string): Promise<void> {
    if (
        !path.isAbsolute(destination) ||
        process.arch !== "x64" ||
        (process.platform !== "win32" && process.platform !== "linux")
    )
        throw new Error(
            "Bun installation requires an absolute directory and Linux/Windows x64."
        );
    if (process.platform === "linux") {
        const report = process.report.getReport();
        const header =
            typeof report === "object" && report !== null && "header" in report
                ? report.header
                : undefined;
        if (
            typeof header !== "object" ||
            header === null ||
            !("glibcVersionRuntime" in header) ||
            typeof header.glibcVersionRuntime !== "string"
        )
            throw new Error(
                "The pinned Linux Bun bootstrap requires glibc; musl is not supported."
            );
    }
    const versionFile = await readFile(
        new URL("../.bun-version", import.meta.url),
        "utf8"
    );
    const revisionFile = await readFile(
        new URL("../.bun-revision", import.meta.url),
        "utf8"
    );
    const version = versionFile.trim();
    const revision = revisionFile.trim();
    if (
        !/^\d+\.\d+\.\d+-canary\.\d{8}\.\d+$/.test(version) ||
        !/^[a-f0-9]{40}$/.test(revision)
    )
        throw new Error("Invalid pinned Bun package or revision.");
    const temporary = await mkdtemp(path.join(tmpdir(), "homelab-bun-"));
    const platform = process.platform === "win32" ? "windows" : "linux";
    const name = `@oven/bun-${platform}-x64`;
    const executable = process.platform === "win32" ? "bun.exe" : "bun";
    try {
        await writeFile(
            path.join(temporary, "package.json"),
            JSON.stringify({
                private: true,
                dependencies: { [name]: version },
            })
        );
        const install = Bun.spawnSync([process.execPath, "install", "--ignore-scripts"], {
            cwd: temporary,
            stdout: "inherit",
            stderr: "inherit",
            timeout: 120_000,
            windowsHide: true,
        });
        if (install.exitCode !== 0) throw new Error("Pinned Bun download failed.");
        const source = path.join(temporary, "node_modules", name, "bin", executable);
        const check = Bun.spawnSync(
            [source, "--no-env-file", "-e", "process.stdout.write(Bun.revision)"],
            {
                cwd: temporary,
                stdout: "pipe",
                stderr: "pipe",
                timeout: 15_000,
                windowsHide: true,
            }
        );
        if (check.exitCode !== 0 || new TextDecoder().decode(check.stdout) !== revision)
            throw new Error("Downloaded Bun does not match the pinned revision.");
        const bin = path.join(destination, "bin");
        await mkdir(bin, { recursive: true });
        const target = path.join(bin, executable);
        // Refuse to overwrite an existing installation, including a running executable.
        await copyFile(source, target, constants.COPYFILE_EXCL);
        await chmod(target, 0o755);
        console.info(`Installed Bun ${version} (${revision.slice(0, 9)}) in ${bin}.`);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const [destination, ...extra] = process.argv.slice(2);
    if (!destination || extra.length > 0)
        throw new Error("Provide one absolute installation directory.");
    await installBun(destination);
}
