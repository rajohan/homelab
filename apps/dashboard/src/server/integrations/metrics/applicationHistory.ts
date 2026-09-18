import type { ApplicationMetric } from "@homelab/contracts/infrastructure";

import { containerCpuExpression } from "./containerCpu";
import { memoryCapacityExpression } from "./memory";
import { nativeResourceExpressions } from "./nativeResources";

/**
 * Restrict resource history to one saved application's reviewed numeric metrics.
 * @param application - The application selected from the server's latest inventory.
 * @returns Fixed expressions; absent or stale collection yields gaps, never healthy zeroes.
 */
export function applicationHistoryExpressions(application: ApplicationMetric) {
    const selector = `host=${JSON.stringify(application.host)},project=${JSON.stringify(application.project)},service=${JSON.stringify(application.name)}`;
    const prefix = `homelab_${application.resourceSource ?? "container"}_`;
    const age = `time() - ${prefix}last_sample_timestamp_seconds{${selector}}`;
    const healthy = `(${prefix}metrics_success{${selector}} == 1) and on(host,project,service) (${age} < 180) and on(host,project,service) (${age} >= -60)`;
    const gate = (expression: string) =>
        `${expression} and on(host,project,service) (${healthy})`;
    const gauge = (name: string) => gate(`${prefix}${name}{${selector}}`);
    const rate = (name: string) => `rate(homelab_container_${name}{${selector}}[5m])`;
    const rates =
        application.resourceSource === "native"
            ? nativeResourceExpressions(selector, true)
            : {
                  cpu: containerCpuExpression(selector, true),
                  receive: rate("network_rx_bytes_total"),
                  transmit: rate("network_tx_bytes_total"),
                  read: rate("block_read_bytes_total"),
                  write: rate("block_write_bytes_total"),
              };
    return {
        cpu: gate(rates.cpu),
        memory: gauge("memory_working_set_bytes"),
        memoryCapacity: gate(
            memoryCapacityExpression(
                `${prefix}memory_limit_bytes{${selector}}`,
                `node_memory_MemTotal_bytes{host=${JSON.stringify(application.host)}}`
            )
        ),
        receive: gate(rates.receive),
        transmit: gate(rates.transmit),
        read: gate(rates.read),
        write: gate(rates.write),
    };
}
