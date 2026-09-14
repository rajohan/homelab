const requested = process.argv.slice(2);
const apps = requested.length === 0 ? ["auth", "dashboard"] : requested;

if (apps.some((app) => app !== "auth" && app !== "dashboard")) {
    throw new Error("Usage: bun run dev [auth|dashboard]");
}

const children = apps.map((app) =>
    Bun.spawn([process.execPath, "--hot", `apps/${app}/src/server/index.ts`], {
        env: { ...process.env, NODE_ENV: "development" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    })
);

function stop() {
    for (const child of children) {
        child.kill("SIGTERM");
    }
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const result = await Promise.race(children.map((child) => child.exited));
stop();
await Promise.all(children.map((child) => child.exited));
process.exitCode = result;
