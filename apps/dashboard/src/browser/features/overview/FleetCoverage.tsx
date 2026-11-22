import { Link } from "@tanstack/react-router";

import type { OverviewReadings } from "./useOverviewReadings";

const colors = {
    healthy: "bg-emerald-300",
    unhealthy: "bg-rose-400",
    unknown: "bg-primary-500",
    stopped: "bg-amber-300",
};

/** Link each part of the monitored estate to its inventory, using one mark per resource for small inventories.
 * @returns Named health counts and accessible links for hosts, applications and probes.
 */
export function FleetCoverage({ readings: r }: { readonly readings: OverviewReadings }) {
    const groups = [
        { label: "Hosts & guests", hash: "hosts", rows: r.hosts },
        { label: "Applications", hash: "applications", rows: r.apps },
        { label: "Service checks", hash: "services", rows: r.probes },
    ];
    return (
        <div aria-label="Monitoring coverage" className="grid min-w-0 gap-2">
            {groups.map(({ label, hash, rows }) => {
                const healthy = rows.filter((item) => item.state === "healthy").length;
                const summary =
                    rows.length > 0
                        ? `${healthy} of ${rows.length} healthy`
                        : "No current reading";
                return (
                    <Link
                        key={hash}
                        to="/infrastructure"
                        hash={hash}
                        title={summary}
                        aria-label={`${label}, ${summary}`}
                        className="group block min-w-0 rounded-sm py-0.5 focus-visible:outline-2 focus-visible:outline-accent-300"
                    >
                        <span className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-primary-200 group-hover:text-white">
                            {label}
                            <span className="tabular-nums">
                                {rows.length > 0 ? `${healthy} / ${rows.length}` : "—"}
                            </span>
                        </span>
                        <span
                            aria-hidden="true"
                            className="flex h-1.5 w-full gap-px overflow-hidden rounded-xs bg-primary-700/50"
                        >
                            {rows.length <= 96
                                ? rows.map((item) => (
                                      <span
                                          key={item.id}
                                          className={`min-w-0 flex-1 ${colors[item.state]}`}
                                          title={`${item.name} · ${item.state}`}
                                      />
                                  ))
                                : (Object.keys(colors) as (keyof typeof colors)[]).map(
                                      (state) => (
                                          <span
                                              key={state}
                                              className={colors[state]}
                                              style={{
                                                  width: `${(100 * rows.filter((item) => item.state === state).length) / rows.length}%`,
                                              }}
                                          />
                                      )
                                  )}
                        </span>
                    </Link>
                );
            })}
        </div>
    );
}
