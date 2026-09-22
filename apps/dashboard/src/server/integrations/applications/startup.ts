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

// Preserve expansion provenance until a token reaches a code position. Never
// expand variables or inspect their potentially private values.
function dynamicShellWord(raw: string): boolean {
    let quote: "'" | '"' | undefined;
    for (let index = 0; index < raw.length; index++) {
        const character = raw[index];
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
            (character === "$" && /[A-Za-z0-9_@*#?$!{(-]/.test(raw[index + 1] ?? "")) ||
            (quote === undefined &&
                ("*?[".includes(character ?? "\0") ||
                    (character === "~" && (index === 0 || raw[index - 1] === "="))))
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
 * @param environment - Effective container environment, inspected in memory; only normalized executable search candidates may be returned.
 * @returns Code paths, or null for execution/loading semantics requiring separate qualification. Callers persist booleans only.
 */
export function startupCodePaths(
    entrypoint: readonly string[] | string | null | undefined,
    command: readonly string[] | string | null | undefined,
    workingDirectory = "/",
    healthcheck?: readonly string[] | null,
    environment?: readonly string[] | null
): readonly string[] | null {
    const paths = new Set<string>();
    let unqualified = false;
    const defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    let searchPath = defaultPath,
        defaultLookup = false;
    const resolve = (cwd: string, value: string): string => {
        if (cwd.includes("\0") || value.includes("\0")) {
            unqualified = true;
            return "/";
        }
        return path.posix.resolve(cwd, value);
    };
    const lookup = (executable: string, cwd: string, selectedPath: string): void => {
        if (executable.includes("\0") || selectedPath.includes("\0")) {
            unqualified = true;
            return;
        }
        for (const root of selectedPath.split(":"))
            paths.add(resolve(resolve(cwd, root || "."), executable));
    };
    const argv = (value: typeof entrypoint): readonly string[] =>
        typeof value === "string" ? words(value) : (value ?? []);
    const assignment = (value: string): void => {
        if (value.startsWith("PATH=")) searchPath = value.slice(5);
        // Loader/search options can contain expansion syntax or private values.
        // Require separate qualification rather than returning any of their data.
        if (
            /^(?:LD_[A-Z_]+|DYLD_[A-Z_]+|BASH_ENV|ENV|ZDOTDIR|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|NODE_OPTIONS|NODE_PATH|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|PERLLIB|LUA_PATH|LUA_CPATH|PHP_INI_SCAN_DIR|PHPRC|CLASSPATH|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)=[\s\S]+$/.test(
                value
            )
        )
            unqualified = true;
    };
    for (const value of environment ?? []) assignment(value);
    const dispatch = (args: readonly string[]): readonly string[] => {
        let selected = args;
        defaultLookup = false;
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
                defaultLookup ||= option.includes("p");
            }
            // -v/-V (including combined flags) describe commands, not execute
            // them. All other dispatch forms retain the selected command tail.
            if (information) return [];
            selected = selected.slice(index);
        }
        return selected;
    };
    const inspect = (
        args: readonly string[],
        cwd: string,
        depth = 0,
        selectedPath = searchPath,
        shellCommand = false
    ): void => {
        const inherited = searchPath;
        inspectCommand(args, cwd, depth, selectedPath, shellCommand);
        searchPath = inherited;
    };
    const inspectCommand = (
        args: readonly string[],
        cwd: string,
        depth: number,
        selectedPath: string,
        shellCommand: boolean
    ): void => {
        const executable = args[0];
        if (!executable) return;
        if (depth > 8) {
            unqualified = true;
            return;
        }
        if (executable.includes("\0")) {
            unqualified = true;
            return;
        }
        const name = path.posix.basename(executable);
        if (executable.includes("/")) paths.add(resolve(cwd, executable));
        else if (!(shellCommand && name === "exec"))
            lookup(executable, cwd, selectedPath);
        if (name === "env") {
            let current = cwd,
                options = true,
                splits = 0;
            const expanded = [...args];
            let index = 1;
            while (index < expanded.length) {
                const arg = expanded[index]!;
                if (
                    options &&
                    (arg === "-" ||
                        arg === "--ignore-environment" ||
                        /^-[i0v]*i[i0v]*$/.test(arg))
                )
                    searchPath = defaultPath;
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
                        if ((option === "u" || option === "unset") && value === "PATH")
                            searchPath = defaultPath;
                        if (option === "f" || option === "file") unqualified = true;
                        if (option === "C" || option === "chdir")
                            current = resolve(cwd, value);
                        if (option === "S" || option === "split-string") {
                            if (
                                ++splits > 8 ||
                                dynamicShellWord(value) ||
                                value.includes("\0")
                            ) {
                                unqualified = true;
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
                    assignment(arg);
                    index++;
                    continue;
                }
                break;
            }
            inspect(expanded.slice(index), current, depth + 1);
            return;
        }
        if (["nice", "nohup", "timeout"].includes(name)) {
            let index = 1;
            while (args[index]?.startsWith("-")) {
                const option = args[index++]!;
                if (option === "--") break;
                if (option === "--help" || option === "--version") return;
                if (
                    (name === "nice" && /^(?:-n|--adjustment)$/.test(option)) ||
                    (name === "timeout" &&
                        /^(?:-[sk]|--signal|--kill-after)$/.test(option))
                )
                    index++;
                else if (
                    (name === "nice" && /^(?:-n.+|-\d+|--adjustment=.+)$/.test(option)) ||
                    (name === "timeout" &&
                        /^(?:-[sk].+|--(?:signal|kill-after)=.+|--(?:foreground|preserve-status|verbose))$/.test(
                            option
                        ))
                )
                    continue;
                else {
                    unqualified = true;
                    return;
                }
            }
            if (name === "timeout") index++; // The duration is not a command.
            inspect(args.slice(index), cwd, depth + 1);
            return;
        }
        if (
            [
                "hash",
                "trap",
                "eval",
                "xargs",
                "parallel",
                "chroot",
                "su",
                "runuser",
                "sudo",
                "doas",
                "setpriv",
                "setsid",
                "chrt",
                "ionice",
                "taskset",
                "stdbuf",
                "flock",
                "watch",
            ].includes(name)
        ) {
            // These utilities defer or dispatch commands using separate grammars.
            unqualified = true;
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
            let index = 1,
                emptyEnvironment = false;
            if (name === "gosu" || name === "su-exec") {
                if (["--help", "--version"].includes(args[index] ?? "")) return;
                if (args[index] === "--") index++;
                if (
                    !args[index] ||
                    args[index]!.startsWith("-") ||
                    args[index]!.includes("\0")
                ) {
                    unqualified = true;
                    return;
                }
                index++; // The user/group is not a command.
            }
            while (args[index]?.startsWith("-")) {
                const option = args[index++]!;
                if (option === "--") break;
                if (["--help", "--version"].includes(option)) return;
                let operand: string | undefined,
                    consumes = false;
                if (name === "exec") {
                    const match = /^-([cl]*)a(.*)$/.exec(option);
                    if (match) {
                        emptyEnvironment ||= match[1]!.includes("c");
                        operand = match[2] || args[index++];
                        consumes = true;
                    } else if (/^-[cl]+$/.test(option))
                        emptyEnvironment ||= option.includes("c");
                    else {
                        unqualified = true;
                        return;
                    }
                } else if (name === "tini") {
                    const match = /^-[sgvw]*[pe](.*)$/.exec(option);
                    if (match) {
                        operand = match[1] || args[index++];
                        consumes = true;
                    } else if (!/^-[sgvw]+$/.test(option)) {
                        unqualified = true;
                        return;
                    }
                } else if (name === "dumb-init") {
                    const match = /^(?:-r(.*)|--rewrite(?:=(.*))?)$/.exec(option);
                    if (match) {
                        operand = match[1] || match[2] || args[index++];
                        consumes = true;
                    } else if (
                        !["-c", "-v", "--single-child", "--verbose"].includes(option)
                    ) {
                        unqualified = true;
                        return;
                    }
                } else {
                    // Vendor wrappers have no universal option grammar.
                    unqualified = true;
                    return;
                }
                if (consumes && (operand === undefined || operand.includes("\0"))) {
                    unqualified = true;
                    return;
                }
            }
            const commandPath = searchPath;
            if (emptyEnvironment) searchPath = defaultPath;
            inspect(args.slice(index), cwd, depth + 1, commandPath);
            return;
        }
        if (["sh", "bash", "dash", "ksh", "zsh", "ash"].includes(name)) {
            let index = 1,
                inline = false;
            while (index < args.length) {
                const option = args[index]!;
                if (option === "--") {
                    index++;
                    break;
                }
                if (!/^[+-]/.test(option) || option === "-") break;
                if (["--help", "--version"].includes(option)) return;
                if (["--rcfile", "--init-file"].includes(option)) {
                    if (args[index + 1]) paths.add(resolve(cwd, args[++index]!));
                } else if (
                    [
                        "--noprofile",
                        "--norc",
                        "--posix",
                        "--restricted",
                        "--verbose",
                    ].includes(option)
                ) {
                    // No operand.
                } else {
                    const match = /^[+-]([abefhkmnptuvxBCEHPTirsDc]*)([oO])(.*)$/.exec(
                        option
                    );
                    if (match) {
                        inline ||= option.startsWith("-") && match[1]!.includes("c");
                        if (!match[3]) index++;
                    } else if (/^[+-][abefhkmnptuvxBCEHPTirsDc]+$/.test(option)) {
                        inline ||= option.startsWith("-") && option.includes("c");
                        if (/[is]/.test(option)) unqualified = true;
                    } else {
                        unqualified = true;
                        return;
                    }
                }
                index++;
            }
            if (!inline) {
                const script = args[index];
                if (script) paths.add(resolve(cwd, script));
                return;
            }
            {
                // Only simple command lists are qualified. Do not guess through
                // compound grammar, redirections or executable expansions.
                if (
                    unqualifiedShell(args[index] ?? "") ||
                    (args[index] ?? "").includes("\0")
                ) {
                    unqualified = true;
                    return;
                }
                let group: string[] = [];
                let current = cwd;
                const finish = () => {
                    const inherited = searchPath;
                    // Shell assignments precede the command but are not executable
                    // words. Values (including quoted paths) must not become code.
                    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(group[0] ?? ""))
                        assignment(group.shift()!);
                    const selected = dispatch(group);
                    if (
                        ["export", "readonly", "declare", "typeset"].includes(
                            selected[0] ?? ""
                        )
                    ) {
                        for (const value of selected.slice(1)) assignment(value);
                    }
                    if (selected[0] === "unset" && selected.slice(1).includes("PATH"))
                        searchPath = defaultPath;
                    if (selected[0] === "eval" || (selected[0] ?? "").includes("\0"))
                        unqualified = true;
                    else if (selected[0] === "cd") {
                        const operands = selected.slice(selected[1] === "--" ? 2 : 1);
                        if (
                            operands.length !== 1 ||
                            operands[0]!.startsWith("-") ||
                            operands[0]!.includes("\0")
                        )
                            unqualified = true;
                        else current = resolve(current, operands[0]!);
                    } else if (
                        !["export", "readonly", "declare", "typeset", "unset"].includes(
                            selected[0] ?? ""
                        )
                    )
                        inspect(
                            selected,
                            current,
                            depth + 1,
                            defaultLookup ? defaultPath : searchPath,
                            true
                        );
                    if (
                        selected.length > 0 &&
                        !["export", "readonly", "declare", "typeset", "unset"].includes(
                            selected[0]!
                        )
                    )
                        searchPath = inherited;
                    group = [];
                };
                for (const token of tokens(args[index] ?? "")) {
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
                        group.push(
                            token.value + (dynamicShellWord(token.raw) ? "\0" : "")
                        );
                    }
                }
                finish();
            }
            return;
        }
        if (name === "." || name === "source") {
            if (args[1]) {
                paths.add(resolve(cwd, args[1]));
                if (!args[1].includes("/")) lookup(args[1], cwd, searchPath);
            }
            return;
        }
        if (name === "java") {
            paths.add(cwd); // Default class path, relative source and module imports.
            const addList = (value: string) => {
                for (const item of value.split(":"))
                    paths.add(resolve(cwd, item.replace(/\/\*$/, "") || "."));
            };
            for (let index = 1; index < args.length; index++) {
                const option = args[index]!;
                if (option === "-jar") {
                    if (args[index + 1]) paths.add(resolve(cwd, args[index + 1]!));
                    return;
                }
                const list =
                    /^(--class-path|--module-path|--upgrade-module-path|--patch-module)(?:=(.*))?$/.exec(
                        option
                    );
                if (list || ["-cp", "-classpath", "-p"].includes(option)) {
                    let value = list?.[2] ?? args[++index];
                    if (value === undefined) {
                        unqualified = true;
                        return;
                    }
                    if (list?.[1] === "--patch-module")
                        value = value.slice(value.indexOf("=") + 1);
                    addList(value);
                } else if (
                    option === "-m" ||
                    option === "--module" ||
                    option.startsWith("--module=")
                )
                    return;
                else if (
                    /^(?:-javaagent:|-agentpath:|-agentlib:|@|-Xbootclasspath|--source)/.test(
                        option
                    )
                ) {
                    unqualified = true;
                    return;
                } else if (
                    /^-D(?:java.library.path|java.class.path|jdk.module.path)=/.test(
                        option
                    )
                )
                    addList(option.slice(option.indexOf("=") + 1));
                else if (
                    option.startsWith("-D") ||
                    /^-Xm[sx]\d+[kKmMgG]?$/.test(option) ||
                    ["-server", "-client", "--enable-preview"].includes(option)
                )
                    continue;
                else if (option.startsWith("-")) {
                    unqualified = true;
                    return;
                } else {
                    paths.add(resolve(cwd, option));
                    return;
                }
            }
            return;
        }
        if (
            /^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|(?:ruby|perl|php|lua|luajit)(?:\d+(?:\.\d+)*)?|npm|npx|yarn|pnpm)$/.test(
                name
            )
        ) {
            // These runtimes can import modules/project code from their working
            // directory even when no startup argument contains a slash.
            paths.add(cwd);
            if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) {
                for (let index = 1; index < args.length; index++) {
                    const arg = args[index]!;
                    if (arg.includes("\0")) {
                        unqualified = true;
                        return;
                    }
                    if (arg === "--") {
                        if (args[index + 1] && args[index + 1] !== "-")
                            paths.add(resolve(cwd, args[index + 1]!));
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
                    paths.add(resolve(cwd, arg));
                    break;
                }
                return;
            }
            if (["deno", "npm", "npx", "yarn", "pnpm"].includes(name)) {
                // Subcommands, project scripts and package execution have
                // independent resolution grammars, not a direct script operand.
                unqualified = true;
                return;
            }
            // All recognized runtimes require explicit qualification for option
            // semantics. Never silently discard a non-Node preload switch.
            for (let index = 1; index < args.length; index++) {
                const option = args[index]!;
                if (option === "--") {
                    if (args[index + 1]) paths.add(resolve(cwd, args[index + 1]!));
                    return;
                }
                if (!option.startsWith("-")) {
                    paths.add(resolve(cwd, option));
                    return;
                }
                if (
                    ["node", "nodejs", "bun"].includes(name) &&
                    /^(?:--(?:no-warnings|trace-warnings|use-strict|enable-source-maps)|--(?:max-old-space-size|stack-size)=\d+)$/.test(
                        option
                    )
                )
                    continue;
                unqualified = true;
                return;
            }
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
