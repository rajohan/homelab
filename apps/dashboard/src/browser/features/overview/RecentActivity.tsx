import { ErrorNotice, EventTimeline, LoadingState, SectionPanel } from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity } from "lucide-react";

import { describeNotification } from "../notifications/describeNotification";
import { notificationTarget } from "../notifications/notificationTarget";
import { notificationHistoryOptions } from "../notifications/queries";

const tones = {
    success: "positive",
    error: "danger",
    warning: "warning",
    info: "neutral",
} as const;

/** Display recent activity from the signed-in operator's notification inbox, without acknowledging entries.
 * @returns A time-ordered list with links to the reported destinations.
 */
export function RecentActivity() {
    const query = useInfiniteQuery(notificationHistoryOptions({ state: "all" }));
    const rows = query.data?.pages[0]?.notifications.slice(0, 5) ?? [];
    return (
        <SectionPanel icon={Activity} title="Recent activity">
            {query.isPending && <LoadingState label="Loading recent activity…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.isSuccess && rows.length === 0 && (
                <p className="text-sm text-primary-400">No recent notifications.</p>
            )}
            <EventTimeline
                presentation="feed"
                events={rows.map((n) => {
                    const target = notificationTarget(n);
                    const { title, label, detail } = describeNotification(n);
                    return {
                        id: n.id,
                        time: n.createdAt,
                        tone: tones[n.severity],
                        label,
                        detail,
                        title: target ? (
                            <Link
                                title={n.title}
                                className="rounded-sm py-1 text-primary-50 decoration-accent-300 underline-offset-4 hover:text-accent-300 hover:underline focus-visible:outline-2 focus-visible:outline-accent-300"
                                {...target}
                            >
                                {title}
                            </Link>
                        ) : (
                            title
                        ),
                    };
                })}
            />
        </SectionPanel>
    );
}
