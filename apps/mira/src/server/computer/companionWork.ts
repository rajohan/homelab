import type { ComputerCompanion } from "./companion";
import { runComputerCommandLoop } from "./companionCommands";
import type { ComputerConsentHost } from "./companionConsent";
import { runComputerConsentLoop } from "./companionLifecycle";
import type { runComputerPresence } from "./companionPresence";

/**
 * Compose local consent and one-time commands inside each presence-owned connection generation.
 * @param options - Fixed private client, vault credential and trusted local host factory.
 * @returns Connection work that joins all native cleanup before presence may reconnect.
 */
export function computerConnectionWork(options: {
    companion: ComputerCompanion;
    credential: string;
    createHost: () => ComputerConsentHost;
}): NonNullable<Parameters<typeof runComputerPresence>[0]["connectionWork"]> {
    const { companion, credential, createHost } = options;
    return ({ connectionId, signal }) =>
        runComputerConsentLoop({
            companion,
            credential,
            createHost,
            connectionId,
            signal,
            runSession: (controller, stopped) =>
                runComputerCommandLoop({
                    companion,
                    credential,
                    controller,
                    signal: stopped,
                }),
        });
}
