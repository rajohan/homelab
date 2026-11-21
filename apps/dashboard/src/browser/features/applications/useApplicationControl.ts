import { useQuery } from "@tanstack/react-query";

import { applicationInventoryOptions } from "./queries";

/** Read container control availability independently of the monitoring collector.
 * @returns The original inventory and host-specific action and log capabilities.
 */
export function useApplicationControl() {
    const query = useQuery(applicationInventoryOptions);
    const hosts = query.data?.inventory?.hosts ?? [];
    const ready = Boolean(query.data?.configured && query.data.fresh && !query.isError);
    return {
        query,
        hosts,
        containers: hosts.flatMap((host) => host.applications),
        projects: query.data?.projects ?? [],
        available: (host: string) =>
            ready && hosts.some((item) => item.id === host && item.available),
        logsAvailable: (host: string) => query.data?.logHosts.includes(host) ?? false,
    };
}
