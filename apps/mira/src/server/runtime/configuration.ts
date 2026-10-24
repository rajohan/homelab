import path from "node:path";

import * as v from "valibot";

const pathSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.check(path.isAbsolute, "An absolute path is required.")
);
export const pilotConfigSchema = v.strictObject({
    command: pathSchema,
    codexHome: pathSchema,
    workspace: pathSchema,
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
});
export type PilotConfig = v.InferOutput<typeof pilotConfigSchema>;

function contains(parent: string, child: string): boolean {
    const part = path.relative(path.resolve(parent), path.resolve(child));
    return (
        !part ||
        (!part.startsWith(`..${path.sep}`) && part !== ".." && !path.isAbsolute(part))
    );
}

/**
 * Validate isolated pilot paths; credentials and model workspace must be separate.
 * @param input - Parsed operator-owned JSON; never a browser request.
 * @returns The validated nonsecret configuration.
 * @throws {Error} A path is invalid or either directory contains the other.
 */
export function parsePilotConfig(input: unknown): PilotConfig {
    const config = v.parse(pilotConfigSchema, input);
    if (
        contains(config.codexHome, config.workspace) ||
        contains(config.workspace, config.codexHome)
    )
        throw new Error(
            "Codex credentials and the pilot workspace must use separate directories."
        );
    return config;
}

/**
 * Build a minimal child environment without inheriting provider keys or host tokens.
 * @param config - The explicit Mira-owned Codex home and workspace.
 * @param source - Host environment used only for basic OS runtime variables.
 * @returns The environment for the isolated app-server child.
 */
export function pilotEnvironment(
    config: PilotConfig,
    source: NodeJS.ProcessEnv
): Record<string, string> {
    const env: Record<string, string> = { CODEX_HOME: config.codexHome };
    for (const key of [
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ])
        if (source[key]) env[key] = source[key];
    return env;
}

/**
 * Build the qualification command with implicit host tools and integrations disabled.
 * @returns Arguments for the supported stdio app-server transport.
 */
export function pilotArguments(): string[] {
    const disabled = [
        "shell_tool",
        "unified_exec",
        "apps",
        "plugins",
        "hooks",
        "computer_use",
        "browser_use",
        "browser_use_external",
        "multi_agent",
        "image_generation",
        "view_image",
        "workspace_dependencies",
    ];
    return [
        ...disabled.flatMap((feature) => ["-c", `features.${feature}=false`]),
        "-c",
        'web_search="disabled"',
        "-c",
        'cli_auth_credentials_store="file"',
        "app-server",
        "--listen",
        "stdio://",
    ];
}
