import path from "node:path";

function tokens(command: string): { value: string; separator: boolean; raw: string }[] {
    return (
        command.match(
            /(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s;|&"'\\])+|[;|&]+|\n/g
        ) ?? []
    )
        .filter((word) => word !== "\\\n")
        .map((word) => ({
            raw: word,
            // Classify before unquoting so literal separators remain arguments.
            separator: /^[;|&\n]+$/.test(word),
            value: word.replaceAll(
                /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])/g,
                (
                    _match,
                    double: string | undefined,
                    single: string | undefined,
                    escaped: string | undefined
                ) =>
                    double === undefined
                        ? (single ?? (escaped === "\n" ? "" : escaped) ?? "")
                        : double.replaceAll("\\\n", "").replaceAll(/\\(["\\$`])/g, "$1")
            ),
        }));
}

function words(command: string): string[] {
    return tokens(command)
        .filter((token) => !token.separator || token.value !== "\n")
        .map((token) => token.value);
}

function unqualifiedShell(command: string): boolean {
    let quote: "'" | '"' | undefined;
    for (let index = 0; index < command.length; index++) {
        const character = command[index];
        if (quote === "'") {
            if (character === "'") quote = undefined;
            continue;
        }
        if (character === "\\") {
            index++;
            continue;
        }
        if (character === '"' || (character === "'" && quote === undefined)) {
            quote = quote === character ? undefined : character;
            continue;
        }
        if (
            character === "`" ||
            (character === "$" &&
                command[index + 1] === "(" &&
                command[index + 2] !== "(") ||
            (quote === undefined && "()<>".includes(character ?? "\0"))
        )
            return true;
    }
    return false;
}

/**
 * Identify startup code without mistaking ordinary flags and data operands for executables.
 * @param entrypoint - Image-resolved or pending Compose entrypoint, never persisted.
 * @param command - Image-resolved or pending Compose command, never persisted.
 * @param workingDirectory - Runtime directory used for relative scripts and module imports.
 * @param healthcheck - Effective Docker healthcheck test vector, never persisted.
 * @returns Code paths, or null for shell syntax requiring separate qualification. Callers persist booleans only.
 */
export function startupCodePaths(
    entrypoint: readonly string[] | string | null | undefined,
    command: readonly string[] | string | null | undefined,
    workingDirectory = "/",
    healthcheck?: readonly string[] | null
): readonly string[] | null {
    const paths = new Set<string>();
    let unqualified = false;
    const argv = (value: typeof entrypoint): readonly string[] =>
        typeof value === "string" ? words(value) : (value ?? []);
    const dispatch = (args: readonly string[]): readonly string[] => {
        let selected = args;
        for (let depth = 0; ["command", "builtin"].includes(selected[0] ?? ""); depth++) {
            if (depth >= 8) {
                unqualified = true;
                return [];
            }
            const name = selected[0];
            let index = 1,
                information = false;
            while (selected[index]?.startsWith("-")) {
                const option = selected[index++]!;
                if (option === "--") break;
                if (option === "--help") return [];
                if (name !== "command" || !/^-[pVv]+$/.test(option)) {
                    unqualified = true;
                    return [];
                }
                information ||= /[Vv]/.test(option);
            }
            // -v/-V (including combined flags) describe commands, not execute
            // them. All other dispatch forms retain the selected command tail.
            if (information) return [];
            selected = selected.slice(index);
        }
        return selected;
    };
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
                // Only simple command lists are qualified. Do not guess through
                // compound grammar, redirections or executable expansions.
                if (unqualifiedShell(args[inline + 1] ?? "")) {
                    unqualified = true;
                    return;
                }
                let group: string[] = [];
                let current = cwd;
                const finish = () => {
                    // Shell assignments precede the command but are not executable
                    // words. Values (including quoted paths) must not become code.
                    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(group[0] ?? "")) group.shift();
                    const selected = dispatch(group);
                    if (selected[0] === "eval" || /[$`]/.test(selected[0] ?? ""))
                        unqualified = true;
                    else if (selected[0] === "cd") {
                        const operands = selected.slice(selected[1] === "--" ? 2 : 1);
                        if (
                            operands.length !== 1 ||
                            operands[0]!.startsWith("-") ||
                            /[$`]/.test(operands[0]!)
                        )
                            unqualified = true;
                        else current = path.posix.resolve(current, operands[0]!);
                    } else inspect(selected, current, depth + 1);
                    group = [];
                };
                for (const token of tokens(args[inline + 1] ?? "")) {
                    if (token.separator) finish();
                    else {
                        if (
                            group.every((word) =>
                                /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
                            ) &&
                            (/^(?:if|then|elif|else|fi|while|until|for|select|in|do|done|case|esac|function|time|!|\{|\}|\[\[|\]\])$/.test(
                                token.raw.replaceAll("\\\n", "")
                            ) ||
                                token.value === "eval")
                        ) {
                            unqualified = true;
                            return;
                        }
                        group.push(token.value);
                    }
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
    if (healthcheck?.[0] === "CMD")
        inspect(healthcheck.slice(1), path.posix.resolve("/", workingDirectory || "/"));
    else if (healthcheck?.[0] === "CMD-SHELL")
        inspect(
            ["/bin/sh", "-c", healthcheck[1] ?? ""],
            path.posix.resolve("/", workingDirectory || "/")
        );
    // CMD is otherwise an argument tail, not an independent executable vector.
    return unqualified ? null : [...paths];
}
