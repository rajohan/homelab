import path from "node:path";

function words(command: string): string[] {
    return (command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+|[;|&]+/g) ?? []).map(
        (word) =>
            word.startsWith('"') || word.startsWith("'") ? word.slice(1, -1) : word
    );
}

/**
 * Identify startup code without mistaking ordinary flags and data operands for executables.
 * @param entrypoint - Image-resolved or pending Compose entrypoint, never persisted.
 * @param command - Image-resolved or pending Compose command, never persisted.
 * @param workingDirectory - Runtime directory used for relative scripts and module imports.
 * @returns Code paths only; callers persist mount-match booleans, not argv or this list.
 */
export function startupCodePaths(
    entrypoint: readonly string[] | string | null | undefined,
    command: readonly string[] | string | null | undefined,
    workingDirectory = "/"
): readonly string[] {
    const paths = new Set<string>();
    const argv = (value: typeof entrypoint): readonly string[] =>
        typeof value === "string" ? words(value) : (value ?? []);
    const inspect = (args: readonly string[], cwd: string, depth = 0): void => {
        const executable = args[0];
        if (!executable || executable.startsWith("-")) return;
        if (depth > 8) {
            paths.add(cwd);
            return;
        }
        const name = path.posix.basename(executable);
        if (executable.includes("/")) paths.add(path.posix.resolve(cwd, executable));
        if (name === "env") {
            let current = cwd,
                options = true,
                splits = 0;
            const expanded = [...args];
            let index = 1;
            while (index < expanded.length) {
                const arg = expanded[index]!;
                if (options && (arg === "--" || arg === "-")) {
                    options = false;
                    index++;
                    continue;
                }
                if (options && arg.startsWith("-")) {
                    const long =
                        /^--(unset|chdir|split-string|argv0|file)(?:=(.*))?$/.exec(arg);
                    const short = /^-[i0v]*([uCSaf])(.*)$/.exec(arg);
                    const option = long?.[1] ?? short?.[1];
                    if (option) {
                        const attached = long ? long[2] : short![2] || undefined;
                        const value = attached ?? expanded[++index];
                        if (value === undefined) return;
                        if (option === "C" || option === "chdir")
                            current = path.posix.resolve(cwd, value);
                        if (option === "S" || option === "split-string") {
                            if (++splits > 8) {
                                paths.add(current);
                                return;
                            }
                            expanded.splice(index + 1, 0, ...words(value));
                        }
                    }
                    index++;
                    continue;
                }
                options = false;
                if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
                    index++;
                    continue;
                }
                break;
            }
            inspect(expanded.slice(index), current, depth + 1);
            return;
        }
        if (
            [
                "exec",
                "tini",
                "dumb-init",
                "gosu",
                "su-exec",
                "docker-entrypoint.sh",
                "docker-entrypoint",
            ].includes(name)
        ) {
            let index = 1;
            if (name === "gosu" || name === "su-exec") index++;
            while (
                args[index]?.startsWith("-") ||
                /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[index] ?? "")
            )
                index++;
            inspect(args.slice(index), cwd, depth + 1);
            return;
        }
        if (["sh", "bash", "dash", "ksh", "zsh", "ash"].includes(name)) {
            const inline = args.findIndex(
                (arg, index) => index > 0 && /^-[^-]*c/.test(arg)
            );
            if (inline === -1) {
                const script = args.slice(1).find((arg) => !arg.startsWith("-"));
                if (script) paths.add(path.posix.resolve(cwd, script));
                return;
            }
            {
                let group: string[] = [];
                let current = cwd;
                const finish = () => {
                    if (group[0] === "cd" && group[1])
                        current = path.posix.resolve(current, group[1]);
                    else inspect(group, current, depth + 1);
                    group = [];
                };
                for (const token of words(args[inline + 1] ?? "")) {
                    if (/^[;|&]+$/.test(token)) finish();
                    else group.push(token);
                }
                finish();
            }
            return;
        }
        if (name === "." || name === "source") {
            if (args[1]) paths.add(path.posix.resolve(cwd, args[1]));
            return;
        }
        if (
            /^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|ruby|perl|php|lua|luajit|npm|npx|yarn|pnpm)$/.test(
                name
            )
        ) {
            // These runtimes can import modules/project code from their working
            // directory even when no startup argument contains a slash.
            paths.add(cwd);
            if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) {
                for (let index = 1; index < args.length; index++) {
                    const arg = args[index]!;
                    if (arg === "--") {
                        if (args[index + 1] && args[index + 1] !== "-")
                            paths.add(path.posix.resolve(cwd, args[index + 1]!));
                        break;
                    }
                    if (arg === "-" || /^-[cm]/.test(arg)) break;
                    // These interpreter options consume an operand, unlike script
                    // arguments, which are ignored once the script is located.
                    if (["-X", "-W", "--check-hash-based-pycs"].includes(arg)) {
                        index++;
                        continue;
                    }
                    if (arg.startsWith("-")) continue;
                    paths.add(path.posix.resolve(cwd, arg));
                    break;
                }
                return;
            }
            const script = args.slice(1).find((arg) => !arg.startsWith("-"));
            if (
                script &&
                !["-m", "-c", "-e", "--eval", "--print"].some((arg) => args.includes(arg))
            )
                paths.add(path.posix.resolve(cwd, script));
        }
    };
    const first = argv(entrypoint),
        second = argv(command);
    inspect([...first, ...second], path.posix.resolve("/", workingDirectory || "/"));
    // CMD is otherwise an argument tail, not an independent executable vector.
    return [...paths];
}
