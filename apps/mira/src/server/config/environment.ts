import { agentMailReadConfiguration } from "../integrations/agentmail/configuration";
import { pilotEnvironment, type PilotConfig } from "../runtime/configuration";

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
    };
}
