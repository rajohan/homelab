import { fileURLToPath } from "node:url";

type Application = "auth" | "dashboard";

/**
 * Select the local artifact or hardened Docker invocation for a built smoke process.
 * @param app - The independently built application to execute.
 * @param args - Bun arguments; never a shell command.
 * @param environment - Only the synthetic application's configuration.
 * @param imagePrefix - Optional local image namespace with tested auth/dashboard tags.
 * @param name - Unique container name, retained for unconditional cleanup.
 * @returns Process arguments, environment and working directory without secret arguments.
 */
export function builtInvocation(
    app: Application,
    args: string[],
    environment: Record<string, string>,
    imagePrefix: string | undefined,
    name: string
): { cmd: string[]; env: Record<string, string | undefined>; cwd?: string } {
    if (!imagePrefix)
        return {
            cmd: [process.execPath, ...args],
            env: environment,
            cwd: fileURLToPath(new URL(`../../apps/${app}/dist/`, import.meta.url)),
        };
    if (!/^[a-z0-9][a-z0-9./_-]*$/.test(imagePrefix))
        throw new Error("Invalid smoke image namespace.");
    const configuration = { ...environment };
    const mounts: string[] = [];
    if (configuration.HOMELAB_AUTH_POLICY_FILE) {
        mounts.push(
            "--mount",
            `type=bind,source=${configuration.HOMELAB_AUTH_POLICY_FILE},target=/etc/homelab-smoke-policy.yml,readonly`
        );
        configuration.HOMELAB_AUTH_POLICY_FILE = "/etc/homelab-smoke-policy.yml";
    }
    return {
        cmd: [
            "docker",
            "run",
            "--rm",
            "--interactive",
            "--name",
            name,
            "--label",
            "homelab.test=container-smoke",
            "--network",
            "host",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--init",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=16m",
            ...mounts,
            ...Object.keys(configuration).flatMap((key) => ["--env", key]),
            "--entrypoint",
            "bun",
            `${imagePrefix}/${app}:tested`,
            ...args,
        ],
        env: { PATH: process.env.PATH, ...configuration },
    };
}

/** Own smoke processes and their exact disposable containers without touching running services. */
export class BuiltRuntime {
    private readonly children: Array<ReturnType<typeof Bun.spawn>> = [];
    private readonly containers: string[] = [];

    /**
     * Start a built application or its administrative CLI with synthetic input.
     * @param app - The application whose artifact/image owns the entry point.
     * @param args - Arguments to Bun inside the selected runtime.
     * @param environment - Isolated test configuration; secrets stay out of command arguments.
     * @param input - Optional private JSON input for the administrative CLI.
     * @returns A process with piped output and a completion promise.
     */
    spawn(
        app: Application,
        args: string[],
        environment: Record<string, string>,
        input?: Blob
    ) {
        const prefix = process.env.HOMELAB_SMOKE_IMAGE_PREFIX;
        const name = `homelab-smoke-${app}-${crypto.randomUUID()}`;
        const invocation = builtInvocation(app, args, environment, prefix, name);
        if (prefix) this.containers.push(name);
        const child = Bun.spawn(invocation.cmd, {
            env: invocation.env,
            ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
            stdin: input ?? "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        this.children.push(child);
        return child;
    }

    /**
     * Remove only this invocation's containers and stop all owned subprocesses.
     * @returns Completion once all processes exit; a cleanup failure fails the smoke test.
     */
    async close(): Promise<void> {
        let cleanupFailed = false;
        for (const name of this.containers) {
            const inspection = Bun.spawnSync(["docker", "container", "inspect", name], {
                stdout: "ignore",
                stderr: "pipe",
            });
            if (inspection.exitCode !== 0) {
                if (!inspection.stderr.toString().includes("No such container"))
                    cleanupFailed = true;
                continue;
            }
            const removed = Bun.spawnSync(["docker", "rm", "--force", name], {
                stdout: "ignore",
                stderr: "ignore",
            });
            cleanupFailed ||= removed.exitCode !== 0;
        }
        for (const child of this.children) child.kill("SIGTERM");
        await Promise.all(
            this.children.map(async (child) => {
                const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
                try {
                    await child.exited;
                } finally {
                    clearTimeout(timer);
                }
            })
        );
        if (cleanupFailed) throw new Error("Disposable smoke container cleanup failed.");
    }
}
