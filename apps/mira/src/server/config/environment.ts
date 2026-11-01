import path from "node:path";

import { computerChildEnvironment } from "../computer/process";
import { agentMailReadConfiguration } from "../integrations/agentmail/configuration";
import { daytonaExecutionConfiguration } from "../integrations/daytona/configuration";
import { githubConfiguration } from "../integrations/github/configuration";
import { hereNowReadConfiguration } from "../integrations/herenow/configuration";
import { moltbookReadConfiguration } from "../integrations/moltbook/configuration";
import { pilotEnvironment, type PilotConfig } from "../runtime/configuration";
import { syntheticConfiguration } from "../runtime/syntheticConfiguration";
import { localCodeEnvironment } from "../sandbox/localBinding";

/**
 * Read only the OS environment needed by the explicitly configured runtime child.
 * @param config - The isolated runtime's nonsecret configuration.
 * @returns A child environment with provider credentials and host tokens omitted.
 */
export function runtimeEnvironment(config: PilotConfig): Record<string, string> {
    return pilotEnvironment(config, process.env);
}

/**
 * Read the standalone executor's explicitly provisioned database and runtime paths.
 * @returns Validated private service settings without implicit desktop credentials.
 */
export function miraEnvironment() {
    const file = process.env.HOMELAB_MIRA_CONFIG;
    const databaseUrl = process.env.HOMELAB_DASHBOARD_DATABASE_URL;
    if (!file || !databaseUrl)
        throw new Error("Mira configuration and dashboard database are required.");
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname === "/")
        throw new Error("A dashboard PostgreSQL database is required.");
    const port = Number(process.env.HOMELAB_MIRA_HEALTH_PORT ?? 3440);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error("Invalid Mira health port.");
    return {
        databaseUrl,
        file,
        port,
        filesDirectory: process.env.HOMELAB_MIRA_FILES_DIR,
        agentMail: agentMailReadConfiguration(process.env),
        moltbook: moltbookReadConfiguration(process.env),
        hereNow: hereNowReadConfiguration(process.env),
        daytona: daytonaExecutionConfiguration(process.env),
        github: githubConfiguration(process.env),
        synthetic: syntheticConfiguration(process.env),
        localCode: localCodeEnvironment(process.env),
    };
}

/**
 * Read the explicit disposable-image profile marker, without exporting any credentials.
 * @returns Snapshot marker or undefined outside the check image; never a security attestation.
 */
export function sandboxProfileEnvironment(): string | undefined {
    return process.env.HOMELAB_MIRA_SANDBOX_PROFILE;
}

/**
 * Select the fixed public-egress proxy inside a locally isolated check container.
 * @returns Only constant proxy variables when explicitly enabled; inherited proxy URLs are never used.
 */
export function sandboxProxyEnvironment(): Record<string, string> {
    const mode = process.env.HOMELAB_MIRA_LOCAL_EGRESS;
    if (mode === undefined) return {};
    if (mode !== "public") throw new Error("Invalid local check network mode.");
    return {
        HTTP_PROXY: "http://mira-egress:3128",
        HTTPS_PROXY: "http://mira-egress:3128",
        http_proxy: "http://mira-egress:3128",
        https_proxy: "http://mira-egress:3128",
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
    };
}

/**
 * Allow only executable lookup for local Docker smoke commands, not registry credentials or remote contexts.
 * @returns Minimal host CLI environment; none of it is passed into the disposable container.
 */
export function sandboxSmokeEnvironment(): Record<string, string> {
    return {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/nonexistent",
    };
}

/**
 * Read the interactive host environment for a supervised native computer child.
 * @returns Only explicit OS and display variables; no model or provider credentials.
 */
export function computerEnvironment(): Record<string, string> {
    return computerChildEnvironment(process.env);
}

/**
 * Identify the disposable hosted Windows qualification job; these markers are not a security attestation.
 * @returns Whether both GitHub Actions and its hosted-runner marker are explicitly present.
 */
export function hostedComputerQualificationEnvironment(): boolean {
    return (
        process.env.GITHUB_ACTIONS === "true" &&
        process.env.RUNNER_ENVIRONMENT === "github-hosted"
    );
}

/**
 * Read the explicitly provisioned private browser-host configuration.
 * @param environment - Explicit host settings, defaulting to the service environment.
 * @returns Validated paths and health/database settings, never inherited by browser workers.
 */
export function browserHostEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env
) {
    const file = environment.HOMELAB_MIRA_BROWSER_CONFIG;
    const databaseUrl = environment.HOMELAB_DASHBOARD_DATABASE_URL;
    const port = Number(environment.HOMELAB_MIRA_BROWSER_HEALTH_PORT ?? 3441);
    if (
        !file ||
        !path.isAbsolute(file) ||
        !databaseUrl ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535
    )
        throw new Error(
            "Browser host configuration, database and health port are required."
        );
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname === "/")
        throw new Error("A product database is required.");
    const filesDirectory = environment.HOMELAB_MIRA_FILES_DIR;
    if (!filesDirectory || !path.isAbsolute(filesDirectory))
        throw new Error("Browser host attachment storage requires an absolute path.");
    return {
        file,
        databaseUrl,
        port,
        filesDirectory,
        localCode: localCodeEnvironment(environment),
    };
}

/**
 * Read the fixed, host-only marker for a bounded saved browser profile.
 * @returns Whether the worker must restore its private profile into the fixed quota-enforced tmpfs.
 */
export function browserWorkerEnvironment(): boolean {
    const marker = process.env.MIRA_BROWSER_PROFILE;
    if (marker === undefined) return false;
    if (
        marker !== "saved" ||
        process.env.CUA_DRIVER_BROWSER_PROFILE_ROOT !== "/var/lib/mira-browser-profile"
    )
        throw new Error("Invalid saved browser profile environment.");
    return true;
}

/**
 * Select the browser container's OS environment and fixed profile/sandbox markers.
 * @returns No product credentials, loader overrides or arbitrary driver options.
 */
export function browserDriverEnvironment(): Record<string, string> {
    const environment = computerEnvironment();
    for (const name of ["CUA_E2E_BROWSER_NO_SANDBOX", "CUA_DRIVER_BROWSER_NO_SANDBOX"])
        if (process.env[name] === "1") environment[name] = "1";
    if (browserWorkerEnvironment())
        environment.CUA_DRIVER_BROWSER_PROFILE_ROOT = "/var/lib/mira-browser-profile";
    return environment;
}
