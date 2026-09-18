/**
 * Aggregate native unit rates only after handling each unit's counter resets.
 * @param selector - Escaped, server-owned application labels; empty selects the inventory.
 * @param historical - Use chart averages instead of the latest counter pair.
 * @returns Fixed CPU, IP-network and block-I/O queries without host-wide substitutions.
 */
export function nativeResourceExpressions(selector = "", historical = false) {
    const rate = historical ? "rate" : "irate";
    const window = historical ? "5m" : "1m";
    const running = `homelab_native_unit_running{${selector}} == 1`;
    const sumRate = (name: string) =>
        `sum by(host,project,service) (${rate}(homelab_native_unit_${name}{${selector}}[${window}]) and on(host,project,service,unit) (${running}))`;
    const available = (name: string, family: string) =>
        `${sumRate(name)} and on(host,project,service) (homelab_native_${family}_available{${selector}} == 1)`;
    return {
        cpu: `100 * ${sumRate("cpu_usage_seconds_total")}`,
        receive: available("network_rx_bytes_total", "network"),
        transmit: available("network_tx_bytes_total", "network"),
        read: available("block_read_bytes_total", "block"),
        write: available("block_write_bytes_total", "block"),
    };
}
