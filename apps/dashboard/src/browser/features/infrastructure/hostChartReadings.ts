import type { InfrastructureHost } from "@homelab/contracts/infrastructure";
import { formatMetric } from "@homelab/ui";

/** Associate the latest host observations with the resource they describe.
 * @param host - The measured host, including partial observations from guest and hypervisor.
 * @returns Available memory details that add information to the primary readings.
 */
export function hostChartReadings(host: InfrastructureHost) {
    const memory: { label: string; value: string }[] = [];
    const assigned = formatMetric(host.allocatedMemory, "bytes");
    if (
        host.allocatedMemory !== null &&
        assigned !== formatMetric(host.memoryTotal, "bytes")
    ) {
        memory.push({ label: "Assigned memory", value: assigned });
    }
    if ((host.swapTotal ?? 0) > 0 || (host.swapUsed ?? 0) > 0) {
        if (host.swapUsed === null)
            memory.push({
                label: "Swap capacity",
                value: formatMetric(host.swapTotal, "bytes"),
            });
        else {
            const total =
                host.swapTotal === null
                    ? ""
                    : ` of ${formatMetric(host.swapTotal, "bytes")}`;
            memory.push({
                label: "Swap used",
                value: formatMetric(host.swapUsed, "bytes") + total,
            });
        }
    }
    return {
        memory: { items: memory },
    };
}
