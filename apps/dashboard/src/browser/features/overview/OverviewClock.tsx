import { useEffect, useState } from "react";

const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    weekday: "long",
    day: "numeric",
    month: "long",
});
const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
});

/** Display the homelab's local date and 24-hour clock independently of data refreshes.
 * @returns A live Oslo clock shared by the web and Windows Overview.
 */
export function OverviewClock() {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const tick = () => setNow(new Date());
        const timer = globalThis.setInterval(tick, 1000);
        document.addEventListener("visibilitychange", tick);
        return () => {
            globalThis.clearInterval(timer);
            document.removeEventListener("visibilitychange", tick);
        };
    }, []);
    return (
        <time
            dateTime={now.toISOString()}
            className="flex flex-wrap items-baseline gap-x-2 text-sm text-primary-400"
        >
            <span>{date.format(now)}</span>
            <span className="font-medium text-primary-100 tabular-nums">
                {time.format(now)}
            </span>
        </time>
    );
}
