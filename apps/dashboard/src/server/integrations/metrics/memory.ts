/**
 * Resolve a measured application's memory ceiling without treating host RAM as reserved.
 * @param limit - Configured bytes; zero means no explicit limit, null is unknown.
 * @param hostTotal - Total OS memory in bytes, not currently free or available memory.
 * @returns The smaller known ceiling, or null when the application limit is unknown.
 */
export function effectiveMemoryCapacity(limit: number | null, hostTotal: number | null) {
    if (limit === null) return null;
    const host = hostTotal !== null && hostTotal > 0 ? hostTotal : null;
    if (limit === 0) return host;
    return host === null ? limit : Math.min(limit, host);
}

function candidate(expression: string, source: string) {
    return `label_replace((${expression}), "capacity_source", "${source}", "", "")`;
}

/**
 * Compute the same effective ceiling from historical gauges at each evaluation time.
 * @param limit - The application-scoped configured-limit expression.
 * @param hostTotal - The host-scoped total-memory expression.
 * @returns PromQL preserving application identity, without fabricating samples.
 */
export function memoryCapacityExpression(limit: string, hostTotal: string) {
    // Carry application labels onto host capacity; a missing limit stays unknown.
    const host = `((${limit} >= 0) * 0) + on(host) group_left() (${hostTotal} > 0)`;
    // Keep both candidates through the union before taking the minimum.
    return `min by(host,project,service) (${candidate(`${limit} > 0`, "limit")} or ${candidate(host, "host")})`;
}
