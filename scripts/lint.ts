import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const typeLintRequire = createRequire(require.resolve("oxlint-tsgolint/package.json"));
const extension = process.platform === "win32" ? ".exe" : "";
const typeLintBinary = typeLintRequire.resolve(
    `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${extension}`
);
const files = process.argv.slice(2);
// Resolve Oxc's native type checker directly, avoiding its Node-shebang launcher.
const child = Bun.spawn(
    [
        process.execPath,
        fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url)),
        "--deny-warnings",
        ...(files.length > 0 ? files : ["."]),
    ],
    {
        env: { ...process.env, OXLINT_TSGOLINT_PATH: typeLintBinary },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }
);
process.exitCode = await child.exited;
