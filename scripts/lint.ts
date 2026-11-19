import { createRequire } from "node:module";

// Stable Bun builds and runs the applications. Only this command needs Canary.
const lintRequire = createRequire(import.meta.resolve("bun-lint-runtime/package.json"));
const platform = process.platform === "win32" ? "windows" : process.platform;
const arch = process.arch === "arm64" ? "aarch64" : process.arch;
const executable = process.platform === "win32" ? "bun.exe" : "bun";
const binary = lintRequire.resolve(`@oven/bun-${platform}-${arch}/bin/${executable}`);
const revision = Bun.spawnSync([binary, "--no-env-file", "-p", "Bun.revision"]);
if (
    revision.exitCode !== 0 ||
    revision.stdout.toString().trim() !== "4ce14ba8b150c3c7315284f3df8480eb4158b38a"
)
    throw new Error("Unexpected Bun lint runtime revision.");

const child = Bun.spawn(
    [binary, "lint", "--no-script", "--deny-warnings", ...process.argv.slice(2)],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
);
process.exitCode = await child.exited;
