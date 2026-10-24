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
    const env: Record<string, string> = {
        CODEX_HOME: config.codexHome,
        HOME: config.codexHome,
        USERPROFILE: config.codexHome,
    };
    for (const key of [
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
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
export const disabledRuntimeFeatures = [
    "sleep_tool",
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
    "remote_plugin",
    "remote_control",
    "tool_suggest",
    "memories",
] as const;

/**
 * Build launch settings that are also checked against effective managed configuration.
 * @returns Arguments for the supported stdio app-server transport.
 */
export function pilotArguments(): string[] {
    return [
        ...disabledRuntimeFeatures.flatMap((feature) => [
            "-c",
            `features.${feature}=false`,
        ]),
        "-c",
        'model_provider="openai"',
        "-c",
        'web_search="disabled"',
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        "project_doc_max_bytes=0",
        "app-server",
        "--listen",
        "stdio://",
    ];
}

/**
 * Reject implicit MCP authority before creating or resuming any model thread.
 * @param input - Effective config returned by the runtime, including system layers.
 * @throws {Error} A managed layer changes the required provider, capabilities or tool isolation.
 */
export function assertRuntimeIsolation(input: unknown): void {
    const { config } = v.parse(
        v.object({
            config: v.object({
                project_doc_max_bytes: v.literal(0),
                mcp_servers: v.record(v.string(), v.unknown()),
                features: v.record(v.string(), v.unknown()),
                web_search: v.literal("disabled"),
                cli_auth_credentials_store: v.literal("file"),
                model_provider: v.literal("openai"),
                openai_base_url: v.nullish(
                    v.picklist([
                        "https://api.openai.com/v1",
                        "https://api.openai.com/v1/",
                    ])
                ),
                chatgpt_base_url: v.nullish(
                    v.picklist([
                        "https://chatgpt.com/backend-api",
                        "https://chatgpt.com/backend-api/",
                    ])
                ),
                instructions: v.nullish(v.never()),
                developer_instructions: v.nullish(v.never()),
                model_instructions_file: v.nullish(v.never()),
                compact_prompt: v.nullish(v.never()),
                experimental_compact_prompt_file: v.nullish(v.never()),
                model_catalog_json: v.nullish(v.never()),
                notify: v.nullish(v.never()),
                otel: v.nullish(v.never()),
                experimental_thread_store: v.nullish(v.never()),
                experimental_thread_store_endpoint: v.nullish(v.never()),
                sqlite_home: v.nullish(v.never()),
                model_providers: v.optional(v.record(v.string(), v.unknown())),
            }),
        }),
        input
    );
    if (Object.keys(config.mcp_servers).length > 0)
        throw new Error("Mira cannot use a runtime with configured MCP servers.");
    if (disabledRuntimeFeatures.some((feature) => config.features[feature] !== false))
        throw new Error("Mira cannot use a runtime with overridden capability settings.");
    if (Object.keys(config.model_providers ?? {}).length > 0)
        throw new Error("Mira cannot use custom model provider definitions.");
}
