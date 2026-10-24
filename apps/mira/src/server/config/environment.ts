import { pilotEnvironment, type PilotConfig } from "../runtime/configuration";

/**
 * Read only the OS environment needed by the explicitly configured runtime child.
 * @param config - The isolated runtime's nonsecret configuration.
 * @returns A child environment with provider credentials and host tokens omitted.
 */
export function runtimeEnvironment(config: PilotConfig): Record<string, string> {
    return pilotEnvironment(config, process.env);
}
