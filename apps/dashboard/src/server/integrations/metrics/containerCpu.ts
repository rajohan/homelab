/**
 * Follow Docker stats: 100 percent represents one fully used logical CPU.
 * @param selector - Escaped, server-owned identity labels; empty selects the approved inventory.
 * @param historical - Use a five-minute average for charts instead of the current counter pair.
 * @returns CPU seconds per elapsed second multiplied by 100, without a host-capacity divisor.
 */
export function containerCpuExpression(selector = "", historical = false): string {
    const rate = historical ? "rate" : "irate";
    const window = historical ? "5m" : "1m";
    return `100 * ${rate}(homelab_container_cpu_usage_seconds_total{${selector}}[${window}])`;
}
