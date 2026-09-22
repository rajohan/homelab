"""One ephemeral, narrowly selected update invocation over an authenticated SSH channel.

No service is installed. Input is created by the worker, never accepted as a browser
command. Output contains only fixed progress phases and the verified version receipt.
"""
import copy
from contextlib import contextmanager
import fcntl
import json
import os
import posixpath
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time


def command(arguments, timeout=120, environment=None, output_limit=2_000_000):
    """Execute argv without a shell, bounding output, runtime and child lifetime."""
    selected_environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "HOME": "/nonexistent", "DEBIAN_FRONTEND": "noninteractive"}
    if environment is not None:
        selected_environment.update(environment)
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True, env=selected_environment)
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Command deadline exceeded")
                for key, _ in selector.select(0.2):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fd)
                    else:
                        output.extend(chunk)
                        if len(output) > output_limit:
                            raise RuntimeError("Command output exceeded its budget")
        if process.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
            raise RuntimeError("Update command failed")
        return output.decode("utf-8", errors="strict").strip()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        process.stdout.close()


def progress(phase):
    """Emit only a code-owned phase, never package-manager or application output."""
    print(json.dumps({"phase": phase}), flush=True)


class UpdateRefusal(RuntimeError):
    """Carry a fixed error category without exposing command output or secrets."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def startup_code_paths(startup):
    """Infer executable/interpreter positions, never ordinary data-path operands."""
    paths = set()
    unqualified = False
    default_path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    search_path, default_lookup = default_path, False
    def assignment(value):
        nonlocal unqualified, search_path
        if value.startswith("PATH="):
            search_path = value[5:]
        # Loader values stay in memory; never return paths or options from them.
        if re.fullmatch(r"(?:LD_[A-Z_]+|DYLD_[A-Z_]+|BASH_ENV|ENV|ZDOTDIR|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|NODE_OPTIONS|NODE_PATH|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|PERLLIB|LUA_PATH|LUA_CPATH|PHP_INI_SCAN_DIR|PHPRC|CLASSPATH|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)=[\s\S]+", value):
            unqualified = True
    for key, value in startup_environment(startup.get("environment")).items():
        if value is not None:
            assignment(key + "=" + value)
    def unqualified_shell(value):
        quote, index = None, 0
        while index < len(value):
            character = value[index]
            following = value[index + 1:index + 3]
            if quote == "'":
                if character == "'":
                    quote = None
            elif character == "\\":
                index += 1
            elif character == '"' or character == "'" and quote is None:
                quote = None if quote == character else character
            elif character == "`" or character == "$" and following.startswith("(") and following != "((" or quote is None and character in "()<>":
                return True
            index += 1
        return False
    def tokens(value):
        def unquote(match):
            if match[1] is not None:
                return re.sub(r'\\(["\\$`])', r'\1', match[1].replace("\\\n", ""))
            return match[2] if match[2] is not None else "" if match[3] == "\n" else match[3]
        # Preserve separator provenance before unquoting literal argument values.
        return [(re.sub(r'''"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])''', unquote, word),
                 re.fullmatch(r"[;|&\n]+", word) is not None, word)
                for word in re.findall(r'''(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s;|&"'\\])+|[;|&]+|\n''', value)
                if word != "\\\n"]
    def dynamic_shell_word(raw):
        quote, index = None, 0
        while index < len(raw):
            character = raw[index]
            if quote == "'":
                if character == "'":
                    quote = None
            elif character == "\\":
                index += 1
            elif character == '"' or character == "'" and quote is None:
                quote = None if quote == character else character
            elif character == "$" and re.match(r"[A-Za-z0-9_@*#?$!{(\-]", raw[index + 1:index + 2]) or quote is None and (character in "*?[" or character == "~" and (index == 0 or raw[index - 1] == "=")):
                return True
            index += 1
        return False
    def words(value):
        return [word for word, separator, _ in tokens(value) if not separator or word != "\n"]
    def argv(value):
        return words(value) if isinstance(value, str) else value or []
    def resolve(cwd, value):
        nonlocal unqualified
        if "\0" in cwd or "\0" in value:
            unqualified = True
            return "/"
        return posixpath.normpath(posixpath.join(cwd, value))
    def lookup(executable, cwd, selected_path):
        nonlocal unqualified
        if "\0" in executable or "\0" in selected_path:
            unqualified = True
            return
        for root in selected_path.split(":"):
            paths.add(resolve(resolve(cwd, root or "."), executable))
    def dispatch(args):
        nonlocal unqualified, default_lookup
        default_lookup = False
        selected, depth = args, 0
        while selected and selected[0] in ("command", "builtin"):
            if depth >= 8:
                unqualified = True
                return []
            depth += 1
            name, index, information = selected[0], 1, False
            while index < len(selected) and selected[index].startswith("-"):
                option = selected[index]
                index += 1
                if option == "--":
                    break
                if option == "--help":
                    return []
                if name != "command" or re.fullmatch(r"-[pVv]+", option) is None:
                    unqualified = True
                    return []
                information = information or "v" in option or "V" in option
                default_lookup = default_lookup or "p" in option
            # Information-only dispatch never executes its command operands.
            if information:
                return []
            selected = selected[index:]
        return selected
    def inspect(args, cwd, depth=0, selected_path=None, shell_command=False):
        nonlocal search_path
        inherited = search_path
        inspect_command(args, cwd, depth, search_path if selected_path is None else selected_path, shell_command)
        search_path = inherited
    def inspect_command(args, cwd, depth, selected_path, shell_command):
        nonlocal unqualified, search_path
        if not args or not args[0]:
            return
        if depth > 8:
            unqualified = True
            return
        if "\0" in args[0]:
            unqualified = True
            return
        executable, name = args[0], posixpath.basename(args[0])
        if "/" in executable:
            paths.add(resolve(cwd, executable))
        elif not (shell_command and name == "exec"):
            lookup(executable, cwd, selected_path)
        if name == "env":
            current, options, splits, index = cwd, True, 0, 1
            expanded = list(args)
            while index < len(expanded):
                arg = expanded[index]
                if options and (arg in ("-", "--ignore-environment") or re.fullmatch(r"-[i0v]*i[i0v]*", arg)):
                    search_path = default_path
                if options and arg in ("--", "-"):
                    options = False
                    index += 1
                    continue
                if options and arg.startswith("-"):
                    long = re.fullmatch(r"--(unset|chdir|split-string|argv0|file)(?:=(.*))?", arg)
                    short = re.fullmatch(r"-[i0v]*([uCSaf])(.*)", arg)
                    option = long[1] if long else short[1] if short else None
                    if option:
                        value = long[2] if long else short[2] or None
                        if value is None:
                            index += 1
                            if index >= len(expanded):
                                return
                            value = expanded[index]
                        if option in ("u", "unset") and value == "PATH":
                            search_path = default_path
                        if option in ("f", "file"):
                            unqualified = True
                        if option in ("C", "chdir"):
                            current = resolve(cwd, value)
                        if option in ("S", "split-string"):
                            splits += 1
                            if splits > 8 or dynamic_shell_word(value) or "\0" in value:
                                unqualified = True
                                return
                            expanded[index + 1:index + 1] = words(value)
                    index += 1
                    continue
                options = False
                if re.match(r"[A-Za-z_][A-Za-z0-9_]*=", arg):
                    assignment(arg)
                    index += 1
                    continue
                break
            inspect(expanded[index:], current, depth + 1)
        elif name in ("nice", "nohup", "timeout"):
            index = 1
            while index < len(args) and args[index].startswith("-"):
                option = args[index]
                index += 1
                if option == "--":
                    break
                if option in ("--help", "--version"):
                    return
                if name == "nice" and option in ("-n", "--adjustment") or name == "timeout" and option in ("-s", "-k", "--signal", "--kill-after"):
                    index += 1
                elif name == "nice" and re.fullmatch(r"(?:-n.+|-\d+|--adjustment=.+)", option) or name == "timeout" and re.fullmatch(r"(?:-[sk].+|--(?:signal|kill-after)=.+|--(?:foreground|preserve-status|verbose))", option):
                    continue
                else:
                    unqualified = True
                    return
            if name == "timeout":
                index += 1
            inspect(args[index:], cwd, depth + 1)
        elif name in ("hash", "trap", "eval", "xargs", "parallel", "chroot", "su", "runuser", "sudo", "doas", "setpriv", "setsid", "chrt", "ionice", "taskset", "stdbuf", "flock", "watch"):
            unqualified = True
        elif name in ("exec", "tini", "dumb-init", "gosu", "su-exec", "docker-entrypoint.sh", "docker-entrypoint"):
            index, empty_environment = 1, False
            if name in ("gosu", "su-exec"):
                if index < len(args) and args[index] in ("--help", "--version"):
                    return
                if index < len(args) and args[index] == "--":
                    index += 1
                if index >= len(args) or args[index].startswith("-") or "\0" in args[index]:
                    unqualified = True
                    return
                index += 1
            while index < len(args) and args[index].startswith("-"):
                option = args[index]
                index += 1
                if option == "--":
                    break
                if option in ("--help", "--version"):
                    return
                operand, consumes = None, False
                if name == "exec":
                    match = re.fullmatch(r"-([cl]*)a(.*)", option)
                    if match:
                        empty_environment = empty_environment or "c" in match[1]
                        operand, consumes = match[2] or None, True
                    elif re.fullmatch(r"-[cl]+", option):
                        empty_environment = empty_environment or "c" in option
                    else:
                        unqualified = True
                        return
                elif name == "tini":
                    match = re.fullmatch(r"-[sgvw]*[pe](.*)", option)
                    if match:
                        operand, consumes = match[1] or None, True
                    elif re.fullmatch(r"-[sgvw]+", option) is None:
                        unqualified = True
                        return
                elif name == "dumb-init":
                    match = re.fullmatch(r"(?:-r(.*)|--rewrite(?:=(.*))?)", option)
                    if match:
                        operand, consumes = match[1] or match[2] or None, True
                    elif option not in ("-c", "-v", "--single-child", "--verbose"):
                        unqualified = True
                        return
                else:
                    unqualified = True
                    return
                if consumes and operand is None:
                    operand = args[index] if index < len(args) else None
                    index += 1
                if consumes and (operand is None or "\0" in operand):
                    unqualified = True
                    return
            command_path = search_path
            if empty_environment:
                search_path = default_path
            inspect(args[index:], cwd, depth + 1, command_path)
        elif name in ("sh", "bash", "dash", "ksh", "zsh", "ash"):
            index, inline = 1, False
            while index < len(args):
                option = args[index]
                if option == "--":
                    index += 1
                    break
                if not re.match(r"^[+-]", option) or option == "-":
                    break
                if option in ("--help", "--version"):
                    return
                if option in ("--rcfile", "--init-file"):
                    if index + 1 < len(args):
                        index += 1
                        paths.add(resolve(cwd, args[index]))
                elif option in ("--noprofile", "--norc", "--posix", "--restricted", "--verbose"):
                    pass
                else:
                    match = re.fullmatch(r"[+-]([abefhkmnptuvxBCEHPTirsDc]*)([oO])(.*)", option)
                    if match:
                        inline = inline or option.startswith("-") and "c" in match[1]
                        if not match[3]:
                            index += 1
                    elif re.fullmatch(r"[+-][abefhkmnptuvxBCEHPTirsDc]+", option):
                        inline = inline or option.startswith("-") and "c" in option
                        if re.search(r"[is]", option):
                            unqualified = True
                    else:
                        unqualified = True
                        return
                index += 1
            if inline:
                # Qualify simple command lists only, never guessed compound
                # grammar, redirections or executable expansions.
                if unqualified_shell(args[index] if len(args) > index else "") or "\0" in (args[index] if len(args) > index else ""):
                    unqualified = True
                    return
                group, current = [], cwd
                for token, separator, raw in tokens(args[index] if len(args) > index else "") + [(";", True, ";")]:
                    if separator:
                        inherited = search_path
                        # Assignment values are data, even if they contain paths.
                        while group and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", group[0]):
                            assignment(group.pop(0))
                        selected = dispatch(group)
                        if selected and selected[0] in ("export", "readonly", "declare", "typeset"):
                            for value in selected[1:]:
                                assignment(value)
                        if selected and selected[0] == "unset" and "PATH" in selected[1:]:
                            search_path = default_path
                        if selected and (selected[0] == "eval" or "\0" in selected[0]):
                            unqualified = True
                        elif selected and selected[0] == "cd":
                            operands = selected[2:] if len(selected) > 1 and selected[1] == "--" else selected[1:]
                            if len(operands) != 1 or operands[0].startswith("-") or "\0" in operands[0]:
                                unqualified = True
                            else:
                                current = resolve(current, operands[0])
                        elif not selected or selected[0] not in ("export", "readonly", "declare", "typeset", "unset"):
                            inspect(selected, current, depth + 1, default_path if default_lookup else search_path, True)
                        if selected and selected[0] not in ("export", "readonly", "declare", "typeset", "unset"):
                            search_path = inherited
                        group = []
                    else:
                        if all(re.match(r"[A-Za-z_][A-Za-z0-9_]*=", word) for word in group) and (re.fullmatch(r"(?:if|then|elif|else|fi|while|until|for|select|in|do|done|case|esac|function|coproc|time|!|\{|\}|\[\[|\]\])", raw.replace("\\\n", "")) or token == "eval"):
                            unqualified = True
                            return
                        group.append(token + ("\0" if dynamic_shell_word(raw) else ""))
            else:
                script = args[index] if index < len(args) else None
                if script:
                    paths.add(resolve(cwd, script))
        elif name in (".", "source"):
            if len(args) > 1:
                paths.add(resolve(cwd, args[1]))
                if "/" not in args[1]:
                    lookup(args[1], cwd, search_path)
        elif name == "java":
            paths.add(cwd)
            def add_list(value):
                for entry in value.split(":"):
                    paths.add(resolve(cwd, re.sub(r"/\*$", "", entry) or "."))
            index = 1
            while index < len(args):
                option = args[index]
                if option == "-jar":
                    if index + 1 < len(args):
                        paths.add(resolve(cwd, args[index + 1]))
                    return
                path_list = re.fullmatch(r"(--class-path|--module-path|--upgrade-module-path|--patch-module)(?:=(.*))?", option)
                if path_list or option in ("-cp", "-classpath", "-p"):
                    value = path_list[2] if path_list else None
                    if value is None:
                        index += 1
                        if index >= len(args):
                            unqualified = True
                            return
                        value = args[index]
                    if path_list and path_list[1] == "--patch-module":
                        value = value[value.find("=") + 1:]
                    add_list(value)
                elif option in ("-m", "--module") or option.startswith("--module="):
                    return
                elif re.match(r"^(?:-javaagent:|-agentpath:|-agentlib:|@|-Xbootclasspath|--source)", option):
                    unqualified = True
                    return
                elif re.match(r"^-D(?:java.library.path|java.class.path|jdk.module.path)=", option):
                    add_list(option.split("=", 1)[1])
                elif option.startswith("-D") or re.fullmatch(r"-Xm[sx]\d+[kKmMgG]?", option) or option in ("-server", "-client", "--enable-preview"):
                    pass
                elif option.startswith("-"):
                    unqualified = True
                    return
                else:
                    paths.add(resolve(cwd, option))
                    return
                index += 1
        elif re.fullmatch(r"(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|(?:ruby|perl|php|lua|luajit)(?:\d+(?:\.\d+)*)?|npm|npx|yarn|pnpm)", name):
            paths.add(cwd)
            if re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", name):
                index = 1
                while index < len(args):
                    arg = args[index]
                    if "\0" in arg:
                        unqualified = True
                        return
                    if arg == "--":
                        if len(args) > index + 1 and args[index + 1] != "-":
                            paths.add(resolve(cwd, args[index + 1]))
                        break
                    if arg == "-" or re.match(r"^-[cm]", arg):
                        break
                    if arg in ("-X", "-W", "--check-hash-based-pycs"):
                        index += 2
                        continue
                    if not arg.startswith("-"):
                        paths.add(resolve(cwd, arg))
                        break
                    index += 1
                return
            if name in ("deno", "npm", "npx", "yarn", "pnpm"):
                unqualified = True
                return
            for index, option in enumerate(args[1:], 1):
                if option == "--":
                    if index + 1 < len(args):
                        paths.add(resolve(cwd, args[index + 1]))
                    return
                if not option.startswith("-"):
                    paths.add(resolve(cwd, option))
                    return
                if name in ("node", "nodejs", "bun") and re.fullmatch(r"(?:--(?:no-warnings|trace-warnings|use-strict|enable-source-maps)|--(?:max-old-space-size|stack-size)=\d+)", option):
                    continue
                unqualified = True
                return
    first, second = argv(startup.get("entrypoint")), argv(startup.get("command"))
    cwd = resolve("/", startup.get("working_dir") or "/")
    inspect(first + second, cwd)
    healthcheck = startup.get("healthcheck") or {}
    health_test = healthcheck.get("Test", healthcheck.get("test")) or []
    if isinstance(health_test, str):
        health_test = ["CMD-SHELL", health_test]
    if not healthcheck.get("disable"):
        if health_test and health_test[0] == "CMD":
            inspect(health_test[1:], cwd)
        elif health_test and health_test[0] == "CMD-SHELL":
            inspect(["/bin/sh", "-c", health_test[1] if len(health_test) > 1 else ""], cwd)
    return None if unqualified else paths


def startup_environment(value):
    """Normalize in-memory Docker/Compose environment without reading env-file contents."""
    if isinstance(value, dict):
        return value
    return dict(entry.split("=", 1) if "=" in entry else (entry, None) for entry in value or [])


def compose_startup(service, defaults):
    """Apply Compose null/empty/omitted startup semantics to installed image defaults."""
    entrypoint = service.get("entrypoint")
    command = service.get("command")
    result = {
        "entrypoint": defaults.get("entrypoint") if entrypoint is None else entrypoint,
        "command": command if command is not None else defaults.get("command") if entrypoint is None else [],
        "working_dir": service.get("working_dir") or defaults.get("working_dir") or "/",
    }
    health = defaults.get("healthcheck") or {}
    override = service.get("healthcheck") or {}
    health_test = health.get("Test", health.get("test"))
    if override.get("disable"):
        health_test = ["NONE"]
    elif override.get("test") is not None:
        health_test = override["test"]
    if health_test is not None:
        result["healthcheck"] = {"test": health_test}
    if "environment" in service or "environment" in defaults:
        result["environment"] = {**startup_environment(defaults.get("environment")), **startup_environment(service.get("environment"))}
    return result


def verify_code_mounts(service, startup=None):
    """Refuse executable deployment mounts without reading config/secret contents."""
    # Compose does not expand inherited service/container storage into volumes.
    # Its effective targets and future provider identity need separate deployment
    # qualification. Never treat these references as paths or assume no mounts.
    if service.get("volumes_from"):
        raise UpdateRefusal("local_code_override")
    paths = startup_code_paths(startup or service)
    effective = startup or service
    # Hooks run independently of ENTRYPOINT/CMD but inherit cwd/environment.
    # Separate-image pre_start hooks require their own deployment qualification.
    if service.get("pre_start"):
        paths = None
    for kind in ("post_start", "pre_stop"):
        for hook in service.get(kind, []):
            command = hook.get("command")
            hook_startup = {
                "entrypoint": ["/bin/sh", "-c", command] if isinstance(command, str) else command,
                "working_dir": hook.get("working_dir") or effective.get("working_dir") or "/",
                "environment": {**startup_environment(effective.get("environment")), **startup_environment(hook.get("environment"))},
            }
            selected = startup_code_paths(hook_startup)
            paths = None if paths is None or selected is None else paths | selected
    mounts = list(service.get("volumes", []))
    for kind, base in (("configs", "/"), ("secrets", "/run/secrets")):
        for entry in service.get(kind, []):
            target = entry if isinstance(entry, str) else entry.get("target") or entry["source"]
            # These sources are Compose object names, never filesystem paths.
            # Only their effective container destinations are needed to qualify code.
            mounts.append({"target": posixpath.join(base, target)})
    for mount in mounts:
        destination = mount.get("target", "")
        # Only the qualified standalone logout helper is exempt, not this directory.
        if destination == "/opt/homelab/logout-worker.js":
            continue
        normalized = posixpath.normpath(destination)
        startup_code = paths is None or any(path == normalized or path.startswith(normalized.rstrip("/") + "/") for path in paths)
        # Named-volume identifiers are not host paths. Their target/startup
        # relationship still matters: updating the image does not replace them.
        source = mount.get("source") if mount.get("type") == "bind" else None
        executable = False
        if source:
            metadata = Path(source).stat()
            executable = Path(source).is_file() and bool(metadata.st_mode & 0o111)
        if executable or startup_code or re.search(r"\.(?:py|pyc|js|mjs|cjs|jsx|ts|tsx|so|node|sh|bash|dash|ksh|zsh|fish|pl|rb|php|lua|ps1|exe|dll|wasm|jar|class|jmod|java)$", destination, re.I) or re.fullmatch(r"(?:/app(?:/(?:src|lib|services|providers|api|utils|cw_platform)(?:/.*)?)?|/(?:usr/(?:local/)?)?(?:bin|sbin|libexec|lib|lib32|lib64)(?:/.*)?|/usr/share/(?:nodejs|node_modules|python\d*(?:\.\d+)*|perl\d*|php|ruby)(?:/.*)?)/?", normalized):
            raise UpdateRefusal("local_code_override")


def file_digest(path):
    """Hash a large executable incrementally rather than holding its old copy in RAM."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def atomic_content(path, contents, expected):
    """Replace one nonsymlink file only if its prior bytes and ownership still match."""
    def matches():
        return file_digest(path) == expected if isinstance(expected, str) else path.read_bytes() == expected
    if path.is_symlink() or path.resolve() != path or not matches():
        raise RuntimeError("Update source changed")
    metadata = path.stat()
    attributes = {name: os.getxattr(path, name, follow_symlinks=False)
                  for name in os.listxattr(path, follow_symlinks=False)}
    # Preserve workspace access ACLs when replacing the inode. Other extended
    # security metadata (for example capabilities) still needs qualification.
    if metadata.st_mode & 0o7000 or set(attributes) - {"system.posix_acl_access"}:
        raise RuntimeError("Update source metadata requires deployment review")
    descriptor, temporary = tempfile.mkstemp(prefix=".homelab-update-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(contents)
            output.flush()
            os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), metadata.st_mode & 0o777)
            # The source's ACL (or its absence), not an inherited default ACL,
            # defines access to the replacement file.
            for name in os.listxattr(output.fileno()):
                if name not in attributes:
                    os.removexattr(output.fileno(), name)
            for name, value in attributes.items():
                os.setxattr(output.fileno(), name, value)
            staged = os.fstat(output.fileno())
            if (staged.st_mode & 0o777, staged.st_uid, staged.st_gid) != (metadata.st_mode & 0o777, metadata.st_uid, metadata.st_gid) or {name: os.getxattr(output.fileno(), name) for name in os.listxattr(output.fileno())} != attributes:
                raise RuntimeError("Update source metadata could not be preserved")
            os.fsync(output.fileno())
        if path.is_symlink() or path.stat().st_ino != metadata.st_ino or path.stat().st_ctime_ns != metadata.st_ctime_ns or not matches():
            raise RuntimeError("Update source changed")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def inspect_container(identity):
    """Read only lifecycle/image identity and Compose ownership labels."""
    template = '{{json .Name}},{{json .Config.Image}},{{json .Image}},{{json .State.Status}},{{json (index .Config.Labels "com.docker.compose.project")}},{{json (index .Config.Labels "com.docker.compose.service")}}'
    return json.loads("[" + command(["/usr/bin/docker", "inspect", "--format", template, identity]) + "]")


def compose_environment(driver):
    """Load explicitly selected interpolation values on the target, never into a file or receipt."""
    source = driver.get("environment")
    if source is None:
        return None
    raw = command(source["command"], timeout=30, output_limit=65_536)
    if len(raw.encode("utf-8")) > 65_536:
        raise RuntimeError("Compose environment exceeds its budget")
    values = json.loads(raw)
    if not isinstance(values, dict):
        raise RuntimeError("Compose environment must be a JSON object")
    selected = {"COMPOSE_DISABLE_ENV_FILE": "1"}
    for name in source["variables"]:
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,99}", name) or re.match(r"^(?:COMPOSE_|DOCKER_|LD_|DYLD_|PYTHON|BASH|SHELL)", name) or name in {"PATH", "HOME", "ENV", "IFS", "LC_ALL", "LANG"}:
            raise RuntimeError("Unsafe Compose environment variable")
        value = values.get(name)
        if not isinstance(value, str) or "\x00" in value or len(value.encode("utf-8")) > 16_384:
            raise RuntimeError("A required Compose environment value is invalid")
        selected[name] = value
    return selected


@contextmanager
def locked_directory(directory):
    """Serialize our Compose edits without leaving a lock or backup file behind."""
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def docker_update(driver, item, automatic=False):
    """Update one image, coordinating approved namespace consumers without changing theirs."""
    candidate = item["availableImage"]
    if not re.fullmatch(r"(?:docker.io|ghcr.io)/[a-z0-9][a-z0-9_./-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[a-f0-9]{64}", candidate):
        raise RuntimeError("An immutable public image candidate is required")
    def repository(reference):
        value = reference.split("@")[0]
        if ":" in value.rsplit("/", 1)[-1]:
            value = value.rsplit(":", 1)[0]
        for prefix in ["registry-1.docker.io/", "index.docker.io/", "docker.io/"]:
            if value.startswith(prefix):
                value = value[len(prefix):]
                break
        if value.startswith("ghcr.io/"):
            return value
        return "docker.io/" + ("library/" if "/" not in value else "") + value
    if repository(item["image"]) != repository(candidate):
        raise RuntimeError("An update cannot change the image repository")
    identity = item["id"].removeprefix("docker:")
    if not re.fullmatch(r"[a-f0-9]{64}", identity):
        raise RuntimeError("Invalid container identity")
    directory, path, main_file = Path(driver["directory"]), Path(driver["imageFile"]), Path(driver["file"])
    if directory.resolve() != directory or path.resolve() != path or main_file.resolve() != main_file or directory not in main_file.parents or directory not in path.parents or path.stat().st_size > 2_000_000:
        raise RuntimeError("Untrusted Compose source path")
    base = ["/usr/bin/docker", "compose", "--project-directory", str(directory), "--project-name", driver["project"], "--file", driver["file"]]
    with locked_directory(directory):
        try:
            before = inspect_container(identity)
        except RuntimeError:
            raise UpdateRefusal("container_changed") from None
        if before[:3] != ["/" + driver["name"], item["image"], item["installed"]] or before[4:] != [driver["project"], driver["service"]] or before[3] not in {"running", "exited", "created"}:
            raise UpdateRefusal("container_changed")
        original = path.read_bytes()
        environment = compose_environment(driver)
        def compose(arguments, timeout=120):
            return command(base + arguments, timeout=timeout, environment=environment)
        config = json.loads(compose(["config", "--format", "json"]))
        service = config.get("services", {}).get(driver["service"], {})
        # Inspect bounded startup/loader inputs in memory, never complete Config
        # or environment values in output, inventory or update receipts.
        startup = json.loads(command(["/usr/bin/docker", "inspect", "--format", '{"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"working_dir":{{json .Config.WorkingDir}},"healthcheck":{{json .Config.Healthcheck}},"environment":{{json .Config.Env}}}', identity]))
        verify_code_mounts(service, startup)
        # Container Config may contain old Compose overrides. Inherit from the
        # immutable installed image, not from those old container overrides.
        # Never classify an unmerged CMD argument tail as an executable vector.
        defaults = json.loads(command(["/usr/bin/docker", "image", "inspect", "--format", '{"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"working_dir":{{json .Config.WorkingDir}},"healthcheck":{{json .Config.Healthcheck}},"environment":{{json .Config.Env}}}', before[2]]))
        verify_code_mounts(service, compose_startup(service, defaults))
        if config.get("services", {}).get(driver["service"], {}).get("image") != item["image"]:
            raise RuntimeError("Compose and the observed image differ")
        namespace_plan = prepare_namespace_plan(config, driver, compose)
        if before[3] == "running":
            docker_health_checks(driver)
        pattern = re.compile(rb"(?m)^([ \t]+image:[ \t]*)([\"']?)" + re.escape(item["image"].encode()) + rb"\2([ \t]*(?:#[^\r\n]*)?\r?)$")
        matches = list(pattern.finditer(original))
        if len(matches) != 1:
            raise RuntimeError("The source must contain one unambiguous literal image")
        match = matches[0]
        replacement = match[1] + match[2] + candidate.encode() + match[2] + match[3]
        updated = original[:match.start()] + replacement + original[match.end():]
        progress("pulling")
        command(["/usr/bin/docker", "pull", candidate], timeout=600)
        candidate_startup = json.loads(command(["/usr/bin/docker", "image", "inspect", "--format", '{"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"working_dir":{{json .Config.WorkingDir}},"healthcheck":{{json .Config.Healthcheck}},"environment":{{json .Config.Env}}}', candidate]))
        verify_code_mounts(service, compose_startup(service, candidate_startup))
        pulled = command(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", candidate])
        if pulled != item["available"]:
            raise RuntimeError("Pulled image does not match the approved platform image")
        if automatic:
            old = image_version(item["image"], item["installed"])
            new = image_version(candidate, pulled)
            if not old or not new or old[0] != new[0] or new < old:
                raise RuntimeError("This image change requires manual approval")
        if inspect_container(identity) != before or json.loads(compose(["config", "--format", "json"])) != config:
            raise RuntimeError("Application or Compose configuration changed during preparation")
        verify_namespace_plan(namespace_plan)
        progress("configuring")
        atomic_content(path, updated, original)
        try:
            expected = copy.deepcopy(config)
            expected["services"][driver["service"]]["image"] = candidate
            if json.loads(compose(["config", "--format", "json"])) != expected:
                raise RuntimeError("The Compose edit changed more than the selected image")
        except Exception:
            atomic_content(path, original, updated)
            raise
        progress("installing")
        stop_namespace_consumers(namespace_plan, driver["service"], compose)
        state = ["--wait", "--wait-timeout", "120"] if before[3] == "running" else ["--no-start"]
        try:
            compose(["up", "--detach", "--no-deps", "--no-build", "--pull", "never"] + state + [driver["service"]], timeout=180)
        except RuntimeError:
            raise UpdateRefusal("application_start_failed") from None
        progress("verifying")
        after = inspect_container(driver["name"])
        if after[1:3] != [candidate, item["available"]] or after[4:] != before[4:] or (before[3] == "running" and after[3] != "running") or (before[3] != "running" and after[3] == "running"):
            raise RuntimeError("Application update could not be verified")
        replacements = restore_namespace_consumers(namespace_plan, driver["service"], compose)
        if before[3] == "running":
            docker_health_checks(driver)
        if replacements:
            print(json.dumps({"recreatedContainers": replacements}), flush=True)
        return item["available"]


def image_version(reference, identity):
    """Classify Docker changes using the actual tag or installed image label, not a publisher assertion."""
    tag = reference.split("@")[0].rsplit("/", 1)[-1].split(":")[-1]
    tag = re.sub(r"-(?:alpine|bookworm|bullseye|trixie|slim)[\d.-]*$", "", tag)
    result = stable_parts(tag)
    if result:
        return result
    label = command(["/usr/bin/docker", "image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', identity])
    return stable_parts(label)


def stable_parts(version):
    """Conservatively extract Debian upstream numeric versions for automatic admission."""
    value = re.sub(r"^\d+:", "", version)
    value = re.sub(r"-\d[^-]*$", "", value)
    match = re.fullmatch(r"v?(\d+)\.(\d+)(?:\.(\d+))?(?:\+[a-zA-Z0-9.]+)?", value)
    return tuple(int(part or 0) for part in match.groups()) if match else None


def apt_update(item, automatic):
    """Use APT for an exact package candidate, preserving holds and refusing removals."""
    import apt
    import apt_pkg
    name = item["id"].removeprefix("apt:")
    if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?", name):
        raise RuntimeError("Invalid package identity")
    cache = apt.Cache()
    package = cache[name]
    # An earlier package in the same confirmed host batch may have installed this dependency.
    # A fresh local inspection is sufficient for a no-op; never reinstall or accept another version.
    if package.installed and package.installed.version == item["available"]:
        progress("verifying")
        return package.installed.version
    if not package.installed or not package.candidate or package.installed.version != item["installed"] or package.candidate.version != item["available"] or package._pkg.selected_state == apt_pkg.SELSTATE_HOLD:
        raise RuntimeError("Package state or repository candidate changed")
    package.mark_install(auto_fix=True, auto_inst=True, from_user=False)
    changes = cache.get_changes()
    if cache.broken_count or any(change.marked_delete or change._pkg.selected_state == apt_pkg.SELSTATE_HOLD for change in changes):
        raise RuntimeError("The update would remove packages or change held software")
    for change in changes:
        if not change.candidate or (change.installed and apt_pkg.version_compare(change.candidate.version, change.installed.version) < 0):
            raise RuntimeError("Package downgrades are not permitted")
        if automatic:
            old = stable_parts(change.installed.version) if change.installed else None
            new = stable_parts(change.candidate.version)
            if not old or not new or old[0] != new[0] or new < old:
                raise RuntimeError("A dependency requires manual approval")
    versions = [change.fullname + "=" + change.candidate.version for change in changes]
    if not versions or len(versions) > 500:
        raise RuntimeError("Unsupported package update plan")
    progress("installing")
    command(["/usr/bin/apt-get", "--assume-yes", "--no-remove", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confold", "install"] + versions, timeout=1200)
    progress("verifying")
    cache.open()
    installed = cache[name].installed
    if not installed or installed.version != item["available"]:
        raise RuntimeError("Installed package version does not match the approved update")
    return installed.version


def native_update(driver, item):
    """Execute a deployment-reviewed native recipe with one exact version parameter."""
    if "recipe" in driver:
        return install_native_recipe(driver, item, command, progress, atomic_content, locked_directory)
    def version():
        output = command(driver["inspect"])
        values = re.findall(r"(?<![0-9])v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)", output)
        if len(set(values)) != 1:
            raise RuntimeError("Native version inspection is ambiguous")
        return values[0]
    if version() != item["installed"].removeprefix("v"):
        raise RuntimeError("Native application version changed")
    candidate = item["available"].removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", candidate):
        raise RuntimeError("An exact stable native version is required")
    progress("installing")
    command([argument.replace("{version}", candidate) for argument in driver["install"]], timeout=1200)
    progress("verifying")
    if version() != candidate:
        raise RuntimeError("Native version verification failed")
    command(driver["health"])
    return item["available"]


def reboot_required():
    """Read the distribution flag without turning a failed observation into false."""
    try:
        os.stat("/var/run/reboot-required")
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return None


def main():
    """Dispatch one fixed update operation and return only its redacted receipt."""
    data = sys.stdin.buffer.read(65537)
    if len(data) > 65536:
        raise RuntimeError("Update input exceeds its budget")
    request = json.loads(data)
    progress("checking")
    driver, item = request["driver"], request["item"]
    if driver["kind"] == "docker":
        installed = docker_update(driver, item, request["automatic"])
    elif driver["kind"] == "apt":
        installed = apt_update(item, request["automatic"])
    elif driver["kind"] == "native":
        installed = native_update(driver, item)
    else:
        raise RuntimeError("Unsupported updater")
    receipt = {"complete": True, "installed": installed, "rebootRequired": reboot_required()}
    if driver["kind"] == "docker":
        receipt["containerId"] = command(["/usr/bin/docker", "inspect", "--format", "{{.Id}}", driver["name"]])
    print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    def interrupted(_number, _frame):
        raise RuntimeError("Update interrupted")
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception as error:
        print(json.dumps({"complete": False, **({"reason": error.reason} if isinstance(error, UpdateRefusal) else {})}), flush=True)
        sys.exit(1)
