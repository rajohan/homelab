import {
    ErrorNotice,
    formatDateTimeParts,
    LoadingState,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { notificationHistoryOptions } from "../notifications/queries";

/** Display recent activity from the signed-in operator's notification inbox, without acknowledging entries.
 * @returns A time-ordered list with links to the reported destinations.
 */
export function RecentActivity() {
    const query = useInfiniteQuery(notificationHistoryOptions({ state: "all" }));
    const rows = query.data?.pages[0]?.notifications.slice(0, 5) ?? [];
    return (
        <section className="min-w-0 space-y-2">
            <SectionHeader title="Recent activity" />
            {query.isPending && <LoadingState label="Loading recent activity…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.isSuccess && rows.length === 0 && (
                <p className="text-sm text-primary-400">No recent notifications.</p>
            )}
            <ul className="divide-y divide-primary-700 border-t border-primary-700">
                {rows.map((n) => {
                    const [date, time] = formatDateTimeParts(n.createdAt);
                    return (
                        <li
                            key={n.id}
                            className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-3 py-3"
                        >
                            <time
                                className="text-xs leading-5 text-primary-400 tabular-nums"
                                dateTime={n.createdAt}
                            >
                                {time}
                                <br />
                                {date}
                            </time>
                            <div className="min-w-0 text-sm wrap-anywhere">
                                {n.destination ? (
                                    <Link
                                        className="hover:text-workspace-accent font-medium"
                                        to={`/${n.destination}`}
                                    >
                                        {n.title}
                                    </Link>
                                ) : (
                                    <strong>{n.title}</strong>
                                )}
                                <p className="line-clamp-2 text-primary-400">
                                    {n.message}
                                </p>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
